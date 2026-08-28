import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtime/server";
import { createRealtimeClient } from "@realtime/client";

const server = createRealtimeServer({
  port: 3003,
  callTimeoutMs: 5_000,
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
  const alice = createRealtimeClient("http://localhost:3003?userId=alice");
  const bob = createRealtimeClient("http://localhost:3003?userId=bob");
  const aliceConnected = waitFor(alice, "connected");
  const bobConnected = waitFor(bob, "connected");
  alice.connect();
  bob.connect();
  await Promise.all([aliceConnected, bobConnected]);
  await Promise.all([alice.joinRoom("call-room"), bob.joinRoom("call-room")]);

  const incoming = waitFor(bob, "call:incoming");
  const started = await alice.startCall("call-room");
  const ringing = await incoming;
  assert.equal(ringing.id, started.id);
  assert.equal(ringing.remoteUserId, "alice");

  const accepted = waitFor(alice, "call:accepted", (call) => call.id === started.id);
  await bob.acceptCall(started.id);
  assert.equal((await accepted).remoteUserId, "bob");

  const offerReceived = waitFor(bob, "webrtc:offer", (event) => event.callId === started.id);
  await alice.sendOffer(started.id, { type: "offer", sdp: "test-offer" });
  assert.equal((await offerReceived).senderId, "alice");
  const answerReceived = waitFor(alice, "webrtc:answer", (event) => event.callId === started.id);
  await bob.sendAnswer(started.id, { type: "answer", sdp: "test-answer" });
  assert.equal((await answerReceived).senderId, "bob");
  const candidateReceived = waitFor(bob, "webrtc:ice-candidate", (event) => event.callId === started.id);
  await alice.sendIceCandidate(started.id, { candidate: "candidate:1 1 udp 1 127.0.0.1 9999 typ host", sdpMid: "0", sdpMLineIndex: 0 });
  assert.equal((await candidateReceived).senderId, "alice");

  const ended = waitFor(alice, "call:ended", (call) => call.id === started.id);
  await bob.hangupCall(started.id);
  assert.equal((await ended).state, "ended");
  console.log("✅ v0.3 smoke test passed: call lifecycle and authenticated WebRTC signaling work.");
  alice.disconnect();
  bob.disconnect();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);
