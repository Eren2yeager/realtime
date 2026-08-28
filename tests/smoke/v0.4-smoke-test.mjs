import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtime/server";
import { createRealtimeClient } from "@realtime/client";

const server = createRealtimeServer({
  port: 3004,
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },
  authorizeRoom: () => true
});

const waitFor = (client, event, matches = () => true) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out waiting for ${event}`)); }, 5_000);
  const unsubscribe = client.on(event, (payload) => {
    if (!matches(payload)) return;
    clearTimeout(timeout);
    unsubscribe();
    resolve(payload);
  });
});

let exitCode = 0;
try {
  await server.start();
  const alice = createRealtimeClient("http://localhost:3004?userId=alice");
  const bob = createRealtimeClient("http://localhost:3004?userId=bob");
  const aliceConnected = waitFor(alice, "connected");
  const bobConnected = waitFor(bob, "connected");
  alice.connect();
  bob.connect();
  await Promise.all([aliceConnected, bobConnected]);
  await Promise.all([alice.joinRoom("video-room"), bob.joinRoom("video-room")]);

  const incoming = waitFor(bob, "call:incoming");
  const call = await alice.startCall("video-room", "video");
  assert.equal((await incoming).mediaType, "video");
  const accepted = waitFor(alice, "call:accepted", (event) => event.id === call.id);
  await bob.acceptCall(call.id);
  assert.equal((await accepted).mediaType, "video");

  // Either participant may now initiate an offer, which is required when a
  // participant adds/removes a screen-video track during an established call.
  const renegotiation = waitFor(alice, "webrtc:offer", (event) => event.callId === call.id);
  await bob.sendOffer(call.id, { type: "offer", sdp: "screen-share-offer" });
  assert.equal((await renegotiation).senderId, "bob");

  await alice.hangupCall(call.id);
  alice.disconnect();
  bob.disconnect();
  console.log("✅ v0.4 smoke test passed: video call contracts and renegotiation signaling work.");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);
