import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtime/server";
import { createRealtimeClient } from "@realtime/client";

const server = createRealtimeServer({
  port: 3001,
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },
  authorizeRoom: () => true
});

const waitFor = (client, event, matches = () => true) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    unsubscribe();
    reject(new Error(`Timed out waiting for ${event}`));
  }, 5_000);
  const unsubscribe = client.on(event, (payload) => {
    if (!matches(payload)) return;
    clearTimeout(timeout);
    unsubscribe();
    resolve(payload);
  });
});

const mustNotReceive = (client, event, matches = () => true) => new Promise((resolve, reject) => {
  const unsubscribe = client.on(event, (payload) => {
    if (matches(payload)) {
      unsubscribe();
      reject(new Error(`Unexpected ${event} event received`));
    }
  });
  setTimeout(() => { unsubscribe(); resolve(); }, 300);
});

try {
  await server.start();
  const alice = createRealtimeClient("http://localhost:3001?userId=alice");
  const aliceSecondTab = createRealtimeClient("http://localhost:3001?userId=alice");
  const bob = createRealtimeClient("http://localhost:3001?userId=bob");

  const aliceConnected = waitFor(alice, "connected");
  const aliceSecondTabConnected = waitFor(aliceSecondTab, "connected");
  const bobConnected = waitFor(bob, "connected");
  alice.connect();
  aliceSecondTab.connect();
  bob.connect();
  await Promise.all([aliceConnected, aliceSecondTabConnected, bobConnected]);

  await alice.joinRoom("test-room");
  await aliceSecondTab.joinRoom("test-room");
  const bobPresence = waitFor(bob, "presence:state", (state) => state.roomId === "test-room");
  const aliceSeesBob = waitFor(alice, "user:online", (event) => event.roomId === "test-room" && event.userId === "bob");
  await bob.joinRoom("test-room");
  assert.deepEqual(new Set((await bobPresence).userIds), new Set(["alice", "bob"]));
  await aliceSeesBob;

  const typingStarted = waitFor(alice, "typing:start", (event) => event.roomId === "test-room" && event.userId === "bob");
  await bob.setTyping("test-room", true);
  await typingStarted;
  const typingStopped = waitFor(alice, "typing:stop", (event) => event.roomId === "test-room" && event.userId === "bob");
  await bob.setTyping("test-room", false);
  await typingStopped;

  const bobSeesAliceTyping = waitFor(bob, "typing:start", (event) => event.roomId === "test-room" && event.userId === "alice");
  const aliceOtherTabDoesNotSeeOwnTyping = mustNotReceive(aliceSecondTab, "typing:start", (event) => event.roomId === "test-room" && event.userId === "alice");
  await alice.setTyping("test-room", true);
  await Promise.all([bobSeesAliceTyping, aliceOtherTabDoesNotSeeOwnTyping]);
  await alice.setTyping("test-room", false);

  const received = waitFor(bob, "message", (message) => message.roomId === "test-room");
  const delivered = waitFor(alice, "message:delivered", (event) => event.roomId === "test-room" && event.recipientId === "bob");
  const message = await alice.sendMessage("test-room", "Hello from v0.2!");
  assert.equal((await received).id, message.id);
  assert.equal((await delivered).messageId, message.id);

  const bobSeesOffline = waitFor(bob, "user:offline", (event) => event.roomId === "test-room" && event.userId === "alice");
  alice.disconnect();
  aliceSecondTab.disconnect();
  await bobSeesOffline;
  const bobSeesAliceAgain = waitFor(bob, "user:online", (event) => event.roomId === "test-room" && event.userId === "alice");
  const aliceReconnected = waitFor(alice, "reconnected");
  alice.connect();
  await Promise.all([aliceReconnected, bobSeesAliceAgain]);
  await alice.sendMessage("test-room", "Room restored after reconnect.");

  console.log("✅ v0.2 smoke test passed: presence, typing, delivery, and reconnection work.");
  alice.disconnect();
  bob.disconnect();
} finally {
  await server.close();
}
