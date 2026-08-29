import assert from "node:assert/strict";
import { createRealtimeServer } from "@realtimesdk/server";
import { createRealtimeClient } from "@realtimesdk/client";
import { createSfuNode } from "@realtimesdk/sfu";

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
              rtcp: { cname: "client-sfu-smoke" }
            }
          : {
              codecs: [{ mimeType: "audio/opus", payloadType: 111, clockRate: 48000, channels: 2 }],
              encodings: [{ ssrc: 12345 }],
              rtcp: { cname: "client-sfu-smoke" }
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

const port = 3018;
const sfu = createSfuNode({ listenIps: [{ ip: "127.0.0.1" }] });
const server = createRealtimeServer({
  port,
  callTimeoutMs: 10_000,
  sfu,
  useSfuForRoom: (roomId) => roomId === "auto-lobby" || roomId === "raw-lobby",
  authenticate(request) {
    const url = new URL(request.url, "http://localhost");
    return { userId: url.searchParams.get("userId") ?? "anonymous" };
  },
  authorizeRoom: () => true
});

const waitFor = (client, event, matches = () => true) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out waiting for ${event}`)); }, 10_000);
  const unsubscribe = client.on(event, (...args) => {
    if (!matches(...args)) return;
    clearTimeout(timeout);
    unsubscribe();
    resolve(args.length === 1 ? args[0] : args);
  });
});

const connectClient = async (userId, options = {}) => {
  const client = createRealtimeClient("http://localhost:" + port + "?userId=" + userId, options);
  const connected = waitFor(client, "connected");
  client.connect();
  await connected;
  return client;
};

let exitCode = 0;
try {
  await server.start();
  await sfu.start();
  await sfu.createRoom("auto-lobby");

  // --- Auto path: startGroupCall and joinCall wire up the SFU themselves. ---
  const alice = await connectClient("alice", { sfuDeviceFactory: () => new FakeDevice() });
  const bob = await connectClient("bob", { sfuDeviceFactory: () => new FakeDevice() });
  await Promise.all([alice.joinRoom("auto-lobby"), bob.joinRoom("auto-lobby")]);

  const bobIncoming = waitFor(bob, "call:incoming", (call) => call.mediaMode === "sfu");
  const started = await alice.startGroupCall("auto-lobby", { video: false });
  assert.equal(started.mediaMode, "sfu");
  assert.ok(started.localStream instanceof FakeMediaStream);
  const ringing = await bobIncoming;
  assert.equal(ringing.id, started.id);

  // Joining auto-publishes Bob's stream and auto-consumes Alice's producer;
  // Alice likewise auto-consumes Bob's producer as soon as it is announced.
  const aliceSeesBobStream = waitFor(alice, "call:stream", (call, stream, peerId) => call.id === started.id && peerId === "bob");
  const bobSeesAliceStream = waitFor(bob, "call:stream", (call, stream, peerId) => call.id === started.id && peerId === "alice");
 const joined = await bob.joinCall(started.id);
 assert.equal(joined.mediaMode, "sfu");
 assert.ok(joined.localStream instanceof FakeMediaStream);
  assert.equal(joined.state, "active");
  assert.equal(alice.getCall(started.id).state, "active");

  const [, aliceStream, alicePeerId] = await aliceSeesBobStream;
  assert.equal(alicePeerId, "bob");
  assert.equal(aliceStream.getAudioTracks()[0].kind, "audio");
 const [, bobStream, bobPeerId] = await bobSeesAliceStream;
 assert.equal(bobPeerId, "alice");
 assert.equal(bobStream.getAudioTracks()[0].kind, "audio");
  assert.equal(alice.getCall(started.id).remoteStreams?.bob?.getAudioTracks()[0].kind, "audio");
  assert.equal(bob.getCall(started.id).remoteStreams?.alice?.getAudioTracks()[0].kind, "audio");

  // Screen sharing publishes a separate video producer; Bob consumes it automatically.
  const bobSeesScreenProducer = waitFor(bob, "sfu:producer-added", (call, event) => event.callId === started.id && event.peerId === "alice" && event.appData?.source === "screen");
  const bobSeesScreen = waitFor(bob, "call:stream", (call, stream, peerId) => call.id === started.id && peerId === "alice" && stream.getVideoTracks().length > 0);
  const screenStream = await alice.startScreenShare(started.id);
  assert.equal(screenStream.getVideoTracks()[0].kind, "video");
  assert.equal(alice.getCall(started.id).isScreenSharing, true);
  const screenProducerEvent = (await bobSeesScreenProducer)[1];
  assert.equal(screenProducerEvent.kind, "video");
 const [, bobScreenStream] = await bobSeesScreen;
 assert.equal(bobScreenStream.getVideoTracks()[0].kind, "video");
  assert.equal(bob.getCall(started.id).screenStreams?.alice?.getVideoTracks()[0].kind, "video");

  // Stopping the share closes the screen producer and notifies Bob.
  const bobSeesRemoved = waitFor(bob, "sfu:producer-removed", (call, event) => event.callId === started.id && event.peerId === "alice");
 await alice.stopScreenShare(started.id);
 assert.equal(alice.getCall(started.id).isScreenSharing, false);
 await bobSeesRemoved;
  assert.equal(bob.getCall(started.id).screenStreams?.alice, undefined);
  assert.equal(bob.getCall(started.id).remoteStreams?.alice?.getAudioTracks().length, 1);

  // Cleanup happens on leave; the SFU room disappears once empty.
  await bob.leaveCall(started.id);
  await alice.leaveCall(started.id);
  assert.equal(sfu.room("auto-lobby"), undefined);

  // --- Explicit path: the raw APIs stay manual with sfuAutoConsume disabled. ---
  await sfu.createRoom("raw-lobby");
  const carol = await connectClient("carol", { sfuDeviceFactory: () => new FakeDevice(), sfuAutoConsume: false });
  const dave = await connectClient("dave", { sfuDeviceFactory: () => new FakeDevice(), sfuAutoConsume: false });
  await Promise.all([carol.joinRoom("raw-lobby"), dave.joinRoom("raw-lobby")]);

  const daveIncoming = waitFor(dave, "call:incoming", (call) => call.mediaMode === "sfu");
  const rawStarted = await carol.startGroupCallRaw("raw-lobby", "audio");
  assert.equal(rawStarted.mediaMode, "sfu");
  await daveIncoming;
  const rawJoined = await dave.joinCallRaw(rawStarted.id);
  assert.equal(rawJoined.mediaMode, "sfu");

  await carol.setupSfuCall(rawStarted.id);
  await dave.setupSfuCall(rawStarted.id);

  const daveSeesProducer = waitFor(dave, "sfu:producer-added", (call, event) => event.callId === rawStarted.id && event.peerId === "carol");
  const published = await carol.publishSfuTrack(rawStarted.id, new FakeMediaStreamTrack("audio"));
  assert.ok(published.producerId);
  const producerEvent = (await daveSeesProducer)[1];
  assert.equal(producerEvent.producerId, published.producerId);

  const consumed = await dave.consumeSfuProducer(rawStarted.id, published.producerId);
  assert.ok(consumed.consumerId);
  assert.equal(consumed.kind, "audio");
  assert.equal(consumed.peerId, "carol");
  assert.ok(consumed.track instanceof FakeMediaStreamTrack);

  await dave.leaveCall(rawStarted.id);
  await carol.leaveCall(rawStarted.id);
  assert.equal(sfu.room("raw-lobby"), undefined);

  console.log("✅ v0.7 client smoke test passed: auto-wired SFU calls publish and consume, and the explicit API still works.");
  alice.disconnect(); bob.disconnect(); carol.disconnect(); dave.disconnect();
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
  await sfu.close();
}

process.exit(exitCode);
