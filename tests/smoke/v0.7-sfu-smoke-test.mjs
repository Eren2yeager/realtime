import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { createRealtimeServer } from "@realtimesdk/server";
import { createSfuNode } from "@realtimesdk/sfu";

const port = 3017;
const sfu = createSfuNode({ listenIps: [{ ip: "127.0.0.1" }] });
const server = createRealtimeServer({
  port,
  callTimeoutMs: 10_000,
  sfu,
  // Only big-lobby routes group media through the SFU; small-lobby stays full-mesh.
  useSfuForRoom: (roomId) => roomId === "big-lobby",
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },
  authorizeRoom: () => true,
});

const connect = (userId) =>
  new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${port}?userId=${userId}`, { transports: ["websocket"] });
    const timer = setTimeout(() => reject(new Error(`Timed out connecting ${userId}`)), 5_000);
    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const request = (socket, event, input) =>
  new Promise((resolve, reject) => {
    socket.emit(event, input, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    });
  });

const waitFor = (socket, event, matches = () => true, timeoutMs = 10_000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const handler = (...args) => {
      if (!matches(...args)) return;
      cleanup();
      resolve(args.length === 1 ? args[0] : args);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(event, handler);
    };
    socket.on(event, handler);
  });

let exitCode = 0;
try {
  await server.start();
  // Warm up the SFU so the first group call does not pay worker/Router cold-start cost.
  await sfu.start();
  await sfu.createRoom("big-lobby");
  const alice = await connect("alice");
  const bob = await connect("bob");
  await Promise.all([request(alice, "protocol:handshake", "0.7"), request(bob, "protocol:handshake", "0.7")]);
  await Promise.all([
    request(alice, "room:join", { roomId: "big-lobby" }),
    request(bob, "room:join", { roomId: "big-lobby" }),
  ]);

  // The SFU-mode group call advertises its media path on start and ring.
  const bobIncoming = waitFor(bob, "group:call:incoming", (event) => event.mediaMode === "sfu");
  const started = await request(alice, "call:start-group", { roomId: "big-lobby", mediaType: "audio" });
  assert.equal(started.mediaMode, "sfu");
  const incoming = await bobIncoming;
  assert.equal(incoming.mediaMode, "sfu");
  assert.equal(incoming.callId, started.callId);
  const joined = await request(bob, "call:join", { callId: started.callId });
  assert.equal(joined.mediaMode, "sfu");

  // The coordinator exposes the router's RTP capabilities.
  const caps = await request(alice, "sfu:rtp-capabilities", { callId: started.callId });
  assert.ok(caps.rtpCapabilities && typeof caps.rtpCapabilities === "object");
  assert.ok(Array.isArray(caps.rtpCapabilities.codecs));

  // Alice creates and connects a send transport and a receive transport.
  const sendTransport = await request(alice, "sfu:create-transport", { callId: started.callId, direction: "send" });
  const recvTransport = await request(alice, "sfu:create-transport", { callId: started.callId, direction: "recv" });
  for (const transport of [sendTransport, recvTransport]) {
    assert.ok(transport.transportId);
    assert.ok(transport.iceParameters.usernameFragment);
    assert.ok(Array.isArray(transport.iceCandidates));
    assert.ok(Array.isArray(transport.dtlsParameters.fingerprints));
  }
  await request(alice, "sfu:connect-transport", {
    callId: started.callId,
    transportId: sendTransport.transportId,
    dtlsParameters: { role: "client", fingerprints: [{ algorithm: "sha-256", value: "AA:BB:CC" }] },
  });

  // Producing notifies the other participant.
  const bobSeesProducer = waitFor(
    bob,
    "sfu:producer-added",
    (event) => event.callId === started.callId && event.peerId === "alice",
  );
  const produced = await request(alice, "sfu:produce", {
    callId: started.callId,
    transportId: sendTransport.transportId,
    kind: "audio",
    rtpParameters: {
      codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }],
      encodings: [{ ssrc: 12345 }],
      rtcp: { cname: "smoke-test" },
    },
  });
  assert.equal(produced.kind, "audio");
  const added = await bobSeesProducer;
  assert.equal(added.producerId, produced.producerId);

  // Bob consumes Alice's producer and resumes it.
  const consumed = await request(bob, "sfu:consume", {
    callId: started.callId,
    transportId: recvTransport.transportId,
    producerId: produced.producerId,
    rtpCapabilities: caps.rtpCapabilities,
  });
  assert.equal(consumed.producerId, produced.producerId);
  assert.equal(consumed.kind, "audio");
  assert.equal(consumed.paused, true);
  await request(bob, "sfu:resume-consumer", { callId: started.callId, consumerId: consumed.consumerId });

  // Closing the producer notifies the other participant.
  const bobSeesRemoved = waitFor(
    bob,
    "sfu:producer-removed",
    (event) => event.callId === started.callId && event.producerId === produced.producerId,
  );
  await request(alice, "sfu:close-producer", { callId: started.callId, producerId: produced.producerId });
  await bobSeesRemoved;

  // Leaving the call cleans up the SFU room once the last participant is gone.
  await request(bob, "call:leave", { callId: started.callId });
  await request(alice, "call:leave", { callId: started.callId });
  assert.equal(sfu.room("big-lobby"), undefined);

  // Rooms excluded by useSfuForRoom stay on the mesh path and reject SFU actions.
  const carol = await connect("carol");
  const dave = await connect("dave");
  await Promise.all([request(carol, "protocol:handshake", "0.7"), request(dave, "protocol:handshake", "0.7")]);
  await Promise.all([
    request(carol, "room:join", { roomId: "small-lobby" }),
    request(dave, "room:join", { roomId: "small-lobby" }),
  ]);
  const daveIncoming = waitFor(dave, "group:call:incoming", (event) => event.mediaMode === "mesh");
  const meshStarted = await request(carol, "call:start-group", { roomId: "small-lobby", mediaType: "audio" });
  assert.equal(meshStarted.mediaMode, "mesh");
  await daveIncoming;
  await assert.rejects(request(carol, "sfu:rtp-capabilities", { callId: meshStarted.callId }), /SFU_UNAVAILABLE/);

  console.log(
    "✅ v0.7 smoke test passed: SFU coordinator assigns rooms, relays transport/produce/consume, broadcasts producers, and cleans up.",
  );
  alice.disconnect();
  bob.disconnect();
  carol.disconnect();
  dave.disconnect();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
  await sfu.close();
}

process.exit(exitCode);
