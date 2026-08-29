/* eslint-disable no-console */
import assert from "node:assert/strict";
import { createSfuNode } from "@realtimesdk/sfu";

const { createRealtimeClient } = await import("@realtimesdk/client");
const { createExpressRealtime } = await import("@realtimesdk/express");
const { directRoomId, PROTOCOL_VERSION } = await import("@realtimesdk/core");

assert.equal(PROTOCOL_VERSION, "0.7", "PROTOCOL_VERSION should be 0.7");
assert.equal(directRoomId("a", "b"), "dm:a:b", "directRoomId helper mismatch");

// Node has no WebRTC media objects; the SDK only stores and forwards these,
// so minimal stubs let the SFU participant flow run end-to-end.
class FakeMediaStreamTrack {
  constructor(kind) { this.kind = kind; this.readyState = "live"; }
  stop() { this.readyState = "ended"; }
}
class FakeMediaStream {
  constructor(tracks = []) { this.tracks = tracks; this.active = true; }
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  addTrack(track) { if (!this.tracks.includes(track)) this.tracks.push(track); }
  removeTrack(track) { this.tracks = this.tracks.filter((item) => item !== track); }
}
globalThis.MediaStream = FakeMediaStream;
globalThis.MediaStreamTrack = FakeMediaStreamTrack;
// The high-level call APIs acquire media through navigator.mediaDevices.
Object.defineProperty(globalThis, "navigator", { value: { mediaDevices: {} }, configurable: true, writable: true });
globalThis.navigator.mediaDevices.getUserMedia = async () => new FakeMediaStream([new FakeMediaStreamTrack("audio")]);
globalThis.navigator.mediaDevices.getDisplayMedia = async () => new FakeMediaStream([new FakeMediaStreamTrack("video")]);

// A fake mediasoup-client Device/Transport. produce() drives the SDK-bound
// connect and produce handlers exactly like mediasoup-client does, so the real
// sfu:connect-transport and sfu:produce requests run against the coordinator.
class FakeTransport {
  constructor(params) {
    this.id = params.id;
    this.handlers = new Map();
    this.producers = new Map();
    this.consumers = new Map();
    this.connected = false;
  }
  on(event, handler) { this.handlers.set(event, handler); return this; }
  async produce({ track, appData }) {
    const connect = this.handlers.get("connect");
    if (connect && !this.connected) {
      this.connected = true;
      await new Promise((resolve, reject) => connect(
        { dtlsParameters: { role: "client", fingerprints: [{ algorithm: "sha-256", value: "AA:BB:CC" }] } },
        resolve,
        reject
      ));
    }
    const produce = this.handlers.get("produce");
    if (!produce) throw new Error("FakeTransport has no produce handler");
    let producerId;
    await new Promise((resolve, reject) => produce(
      {
        kind: track.kind,
        rtpParameters: track.kind === "video"
          ? {
              codecs: [{ mimeType: "video/VP8", payloadType: 96, clockRate: 90000 }],
              encodings: [{ ssrc: 12346 }],
              rtcp: { cname: "public-sfu-smoke" }
            }
          : {
              codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }],
              encodings: [{ ssrc: 12345 }],
              rtcp: { cname: "public-sfu-smoke" }
            },
        appData
      },
      ({ id }) => { producerId = id; resolve(); },
      reject
    ));
    const producer = { id: producerId, kind: track.kind, close() { this.closed = true; } };
    this.producers.set(producerId, producer);
    return producer;
  }
  async consume({ id, producerId, kind, rtpParameters }) {
    const consumer = {
      id,
      producerId,
      kind,
      rtpParameters,
      track: new FakeMediaStreamTrack(kind),
      paused: true,
      resume() { this.paused = false; },
      close() { this.closed = true; }
    };
    this.consumers.set(id, consumer);
    return consumer;
  }
  close() { this.closed = true; }
}

class FakeDevice {
  constructor() { this.rtpCapabilities = { codecs: [] }; }
  async load({ routerRtpCapabilities }) { this.rtpCapabilities = routerRtpCapabilities; }
  createSendTransport(params) { return new FakeTransport(params); }
  createRecvTransport(params) { return new FakeTransport(params); }
}

const app = (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
};

const sfu = createSfuNode({ listenIps: [{ ip: "127.0.0.1" }] });
const server = createExpressRealtime(app, {
  port: 0,
  sfu,
  useSfuForRoom: (roomId) => roomId === "sfu-lobby",
  authenticate: (request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    return { userId: url.searchParams.get("userId") ?? `anon-${Math.random().toString(36).slice(2, 8)}` };
  },
  authorizeRoom: ({ user, roomId }) => roomId === "public-smoke-room" || roomId === "sfu-lobby" || roomId.startsWith(`private:${user.userId}:`)
});

await server.start();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}`;
console.log(`Server listening on ${url}`);

let exitCode = 0;
try {
  const waitFor = (client, event, matches = () => true) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 8_000);
      const off = client.on(event, (...args) => {
        if (!matches(...args)) return;
        clearTimeout(timer);
        off();
        resolve(args);
      });
    });

  const healthRes = await fetch(`${url}/health`);
  assert.equal(healthRes.status, 200, "/health should respond");
  assert.deepEqual(await healthRes.json(), { ok: true });
  console.log("✔ Express /health endpoint reachable");

  const alice = createRealtimeClient(`${url}?userId=alice`);
  const bob = createRealtimeClient(`${url}?userId=bob`);
  const roomId = "public-smoke-room";

  alice.connect();
  bob.connect();

  const bobMessageReceived = waitFor(bob, "message");

  await Promise.all([waitFor(alice, "connected"), waitFor(bob, "connected")]);
  await Promise.all([alice.joinRoom(roomId), bob.joinRoom(roomId)]);

  await alice.sendMessage(roomId, "hello from npm");
  const [received] = await bobMessageReceived;
  assert.equal(received.roomId, roomId);
  assert.equal(received.senderId, "alice");
  assert.equal(received.content, "hello from npm");
  console.log("✔ Cross-client messaging via published packages works");

  const directRoom = directRoomId("alice", "bob");
  assert.ok(directRoom.startsWith("dm:"), "direct room id format");
  console.log(`✔ directRoomId helper resolves to ${directRoom}`);

  // --- SFU group calls: media routes through the published @realtimesdk/sfu node. ---
  const carol = createRealtimeClient(`${url}?userId=carol`, { sfuDeviceFactory: () => new FakeDevice() });
  const dave = createRealtimeClient(`${url}?userId=dave`, { sfuDeviceFactory: () => new FakeDevice() });
  carol.connect();
  dave.connect();
  await Promise.all([waitFor(carol, "connected"), waitFor(dave, "connected")]);
  await Promise.all([carol.joinRoom("sfu-lobby"), dave.joinRoom("sfu-lobby")]);

  const daveIncoming = waitFor(dave, "call:incoming", (call) => call.mediaMode === "sfu");
  const started = await carol.startGroupCall("sfu-lobby", { video: false });
  assert.equal(started.mediaMode, "sfu");
  const ringing = (await daveIncoming)[0];
  assert.equal(ringing.id, started.id);

  const daveSeesCarol = waitFor(dave, "call:stream", (call, stream, peerId) => call.id === started.id && peerId === "carol");
  const joined = await dave.joinCall(started.id);
  assert.equal(joined.mediaMode, "sfu");
  assert.equal(joined.state, "active");
  const [, daveStream] = await daveSeesCarol;
  assert.equal(daveStream.getAudioTracks()[0].kind, "audio");

  const daveSeesScreen = waitFor(dave, "call:stream", (call, stream, peerId) => call.id === started.id && peerId === "carol" && stream.getVideoTracks().length > 0);
  const screenStream = await carol.startScreenShare(started.id);
  assert.equal(screenStream.getVideoTracks()[0].kind, "video");
  const [, screen] = await daveSeesScreen;
  assert.equal(screen.getVideoTracks()[0].kind, "video");

  const daveSeesRemoved = waitFor(dave, "sfu:producer-removed", (call, event) => event.callId === started.id && event.peerId === "carol");
  await carol.stopScreenShare(started.id);
  await daveSeesRemoved;
  assert.equal(dave.getCall(started.id).screenStreams?.carol, undefined);
  console.log("✔ SFU group call with screen sharing via published packages works");

  await dave.leaveCall(started.id);
  await carol.leaveCall(started.id);
  assert.equal(sfu.room("sfu-lobby"), undefined);
  console.log("✔ SFU room cleanup after leave works");

  alice.destroy();
  bob.destroy();
  carol.destroy();
  dave.destroy();
  console.log("\n✅ public-registry smoke test passed");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
  await sfu.close();
  process.exit(exitCode);
}