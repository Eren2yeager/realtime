import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtime/server";
import { createRealtimeClient } from "@realtime/client";

const server = createRealtimeServer({
  port: 3001,

  // Local test only—replace with real auth in an application.
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },

  authorizeRoom() {
    return true;
  }
});

const waitFor = (client, event) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5_000);

    const unsubscribe = client.on(event, (...args) => {
      clearTimeout(timeout);
      unsubscribe();
      resolve(args);
    });
  });

let exitCode = 0;
try {
  await server.start();

  const alice = createRealtimeClient("http://localhost:3001?userId=alice");
  const bob = createRealtimeClient("http://localhost:3001?userId=bob");

  const aliceConnected = waitFor(alice, "connected");
  const bobConnected = waitFor(bob, "connected");
  alice.connect();
  bob.connect();
  await Promise.all([aliceConnected, bobConnected]);

  await Promise.all([
    alice.joinRoom("test-room"),
    bob.joinRoom("test-room")
  ]);

  const bobReceivedMessage = waitFor(bob, "message");
  await alice.sendMessage("test-room", "Hello Bob!");

  const [message] = await bobReceivedMessage;
  assert.equal(message.roomId, "test-room");
  assert.equal(message.senderId, "alice");
  assert.equal(message.content, "Hello Bob!");

  console.log("✅ v0.1 smoke test passed: messaging");
  alice.disconnect();
  bob.disconnect();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);