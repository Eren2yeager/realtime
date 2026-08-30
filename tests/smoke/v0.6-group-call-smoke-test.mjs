import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtimesdk/server";
import { createRealtimeClient } from "@realtimesdk/client";

// The client SDK creates real RTCPeerConnections when answering group offers.
// In Node there is no WebRTC, so provide a minimal stub that lets the full-mesh
// signaling flow run end-to-end without touching the network.
class FakeRTCPeerConnection {
  signalingState = "stable";
  connectionState = "new";
  localDescription = null;
  remoteDescription = null;
  onicecandidate = null;
  ontrack = null;
  onconnectionstatechange = null;
  constructor() {}
  addTrack() {
    return {};
  }
  getSenders() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fake-answer" };
  }
  async setLocalDescription(description) {
    this.localDescription = description;
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }
  async addIceCandidate() {}
  close() {}
}
globalThis.RTCPeerConnection = FakeRTCPeerConnection;

const server = createRealtimeServer({
  port: 3006,
  callTimeoutMs: 5_000,
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },
  authorizeRoom: () => true,
});

const waitFor = (client, event, matches = () => true) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${event}`));
    }, 5_000);
    const unsubscribe = client.on(event, (...args) => {
      if (!matches(...args)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(args.length === 1 ? args[0] : args);
    });
  });

let exitCode = 0;
try {
  await server.start();
  const alice = createRealtimeClient("http://localhost:3006?userId=alice");
  const bob = createRealtimeClient("http://localhost:3006?userId=bob");
  const carol = createRealtimeClient("http://localhost:3006?userId=carol");
  const aliceConnected = waitFor(alice, "connected");
  const bobConnected = waitFor(bob, "connected");
  const carolConnected = waitFor(carol, "connected");
  alice.connect();
  bob.connect();
  carol.connect();
  await Promise.all([aliceConnected, bobConnected, carolConnected]);
  await Promise.all([alice.joinRoom("lobby"), bob.joinRoom("lobby"), carol.joinRoom("lobby")]);

  // Alice rings the whole room; bob and carol each receive the group incoming event.
  const bobIncoming = waitFor(bob, "call:incoming");
  const carolIncoming = waitFor(carol, "call:incoming");
  const started = await alice.startGroupCallRaw("lobby", "audio");
  assert.equal(started.isGroup, true);
  assert.equal(started.callerId, "alice");
  assert.deepEqual([...started.participantIds].sort(), ["alice", "bob", "carol"]);
  const bobRinging = await bobIncoming;
  const carolRinging = await carolIncoming;
  assert.equal(bobRinging.id, started.id);
  assert.equal(bobRinging.isGroup, true);
  assert.equal(bobRinging.callerId, "alice");
  assert.deepEqual([...bobRinging.participantIds].sort(), ["alice", "bob", "carol"]);
  assert.equal(carolRinging.id, started.id);

  // Bob joins; the caller (alice) is notified of the new participant.
  const aliceSeesBob = waitFor(
    alice,
    "group:call:participant-joined",
    (call, participantId) => call.id === started.id && participantId === "bob",
  );
  const bobJoined = await bob.joinCallRaw(started.id);
  assert.equal(bobJoined.isGroup, true);
  // Join results list only participants who have joined so far (carol has not yet joined).
  assert.deepEqual([...bobJoined.participantIds].sort(), ["alice", "bob"]);
  const [, bobId] = await aliceSeesBob;
  assert.equal(bobId, "bob");

  // Full-mesh signaling relays offer, answer, and ICE candidates to an explicit target.
  const bobOffer = waitFor(
    bob,
    "group:webrtc:offer",
    (event) => event.callId === started.id && event.targetId === "bob",
  );
  const aliceAutoAnswer = waitFor(
    alice,
    "group:webrtc:answer",
    (event) => event.callId === started.id && event.targetId === "alice" && event.description.sdp === "fake-answer",
  );
  await alice.sendGroupOffer(started.id, "bob", { type: "offer", sdp: "group-offer" });
  assert.equal((await bobOffer).senderId, "alice");
  // Bob auto-answers the offer through the client SDK path.
  assert.equal((await aliceAutoAnswer).senderId, "bob");
  const aliceManualAnswer = waitFor(
    alice,
    "group:webrtc:answer",
    (event) => event.callId === started.id && event.targetId === "alice" && event.description.sdp === "group-answer",
  );
  await bob.sendGroupAnswer(started.id, "alice", { type: "answer", sdp: "group-answer" });
  assert.equal((await aliceManualAnswer).senderId, "bob");
  const bobCandidate = waitFor(
    bob,
    "group:webrtc:ice-candidate",
    (event) => event.callId === started.id && event.targetId === "bob",
  );
  await alice.sendGroupIceCandidate(started.id, "bob", {
    candidate: "candidate:1 1 udp 1 127.0.0.1 9999 typ host",
    sdpMid: "0",
    sdpMLineIndex: 0,
  });
  const ice = await bobCandidate;
  assert.equal(ice.senderId, "alice");
  assert.equal(ice.targetId, "bob");

  // Carol joins; both alice and bob learn about the new participant.
  const aliceSeesCarol = waitFor(
    alice,
    "group:call:participant-joined",
    (call, participantId) => call.id === started.id && participantId === "carol",
  );
  const bobSeesCarol = waitFor(
    bob,
    "group:call:participant-joined",
    (call, participantId) => call.id === started.id && participantId === "carol",
  );
  await carol.joinCallRaw(started.id);
  await Promise.all([aliceSeesCarol, bobSeesCarol]);

  // Carol leaves; participants are notified without ending the call.
  const aliceSeesCarolLeft = waitFor(
    alice,
    "group:call:participant-left",
    (call, participantId) => call.id === started.id && participantId === "carol",
  );
  const bobSeesCarolLeft = waitFor(
    bob,
    "group:call:participant-left",
    (call, participantId) => call.id === started.id && participantId === "carol",
  );
  await carol.leaveCall(started.id);
  await Promise.all([aliceSeesCarolLeft, bobSeesCarolLeft]);

  // Bob leaves; only alice is now in the call.
  const aliceSeesBobLeft = waitFor(
    alice,
    "group:call:participant-left",
    (call, participantId) => call.id === started.id && participantId === "bob",
  );
  await bob.leaveCall(started.id);
  await aliceSeesBobLeft;

  // Alice leaves as the last participant; the call ends locally for her.
  const aliceEnded = waitFor(alice, "call:ended", (call) => call.id === started.id);
  await alice.leaveCall(started.id);
  const [aliceEndedCall] = await aliceEnded;
  assert.equal(aliceEndedCall.state, "ended");

  // A rejection only removes the inviter from the ring; the call itself stays alive.
  const dave = createRealtimeClient("http://localhost:3006?userId=dave");
  const eve = createRealtimeClient("http://localhost:3006?userId=eve");
  const daveConnected = waitFor(dave, "connected");
  const eveConnected = waitFor(eve, "connected");
  dave.connect();
  eve.connect();
  await Promise.all([daveConnected, eveConnected]);
  await Promise.all([dave.joinRoom("reject-room"), eve.joinRoom("reject-room")]);
  const eveIncoming = waitFor(eve, "call:incoming");
  const daveCall = await dave.startGroupCallRaw("reject-room", "audio");
  const eveRinging = await eveIncoming;
  const daveRejected = waitFor(dave, "call:rejected", (call) => call.id === daveCall.id);
  await eve.rejectCall(eveRinging.id);
  await daveRejected;
  const daveEnded = waitFor(dave, "call:ended", (call) => call.id === daveCall.id);
  await dave.hangupCall(daveCall.id);
  const [daveEndedCall] = await daveEnded;
  assert.equal(daveEndedCall.state, "ended");

  console.log(
    "✅ v0.6 smoke test passed: group audio/video calls, full-mesh signaling, join/leave, and rejection work.",
  );
  alice.disconnect();
  bob.disconnect();
  carol.disconnect();
  dave.disconnect();
  eve.disconnect();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}

process.exit(exitCode);
