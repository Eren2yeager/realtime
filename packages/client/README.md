# @realtimesdk/client

[![npm version](https://img.shields.io/npm/v/@realtimesdk/client.svg)](https://www.npmjs.com/package/@realtimesdk/client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Browser client SDK for the realtimesdk platform: rooms, presence, messaging, and WebRTC calls.

## Install

```bash
npm install @realtimesdk/client
```

## Usage

```ts
import { Device } from "mediasoup-client";
import { createRealtimeClient } from "@realtimesdk/client";

const realtime = createRealtimeClient("http://localhost:3001", {
  auth: { token: "application-token" }
});

realtime.on("connected", async () => {
  await realtime.joinRoom("lobby");
  await realtime.sendMessage("lobby", "Hello!");
});
realtime.on("message", (message) => console.log(message));
realtime.connect();
```

## Audio and video calls

Application-provided STUN/TURN configuration. Media remains peer-to-peer.

```ts
const realtime = createRealtimeClient("http://localhost:3001", {
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    { urls: "turn:turn.example.com:3478", username: "user", credential: "secret" }
  ]
});

realtime.on("call:incoming", (call) => realtime.answerAudioCall(call.id));
realtime.on("call:stream", (call, stream) => { audio.srcObject = stream; });

const call = await realtime.startVideoCall("private:alice:bob");
```

## SFU group calls

For large rooms the server can route group media through an `@realtimesdk/sfu`
media node instead of a full mesh. Group calls in an SFU-routed room report
`mediaMode: "sfu"`, and `startGroupCall`/`joinCall` wire the SFU up for you:
they set up the mediasoup transports, publish the local stream, and consume
remote producers as they are announced.

```ts
import { Device } from "mediasoup-client";
import { createRealtimeClient } from "@realtimesdk/client";

const realtime = createRealtimeClient("http://localhost:3001", {
  // Defaults to a real mediasoup-client Device; override for testing or custom transports.
  sfuDeviceFactory: () => new Device()
});

realtime.on("call:stream", (call, stream, peerId) => { remoteVideo.srcObject = stream; });

const call = await realtime.startGroupCall("big-lobby");
// No extra wiring needed: SFU setup, publishing, and consuming are automatic.
```

For manual control, the SDK exposes `setupSfuCall` (idempotent; loads router
capabilities and creates send/receive transports), `publishSfuTrack`, and
`consumeSfuProducer`. Set `sfuAutoConsume: false` to disable automatic
consumption, and use the raw `startGroupCallRaw`/`joinCallRaw` APIs to skip
auto-wiring entirely. Screen sharing follows the same path: `startScreenShare` publishes a separate video producer, announced to peers with `appData.source === "screen"`, that is consumed automatically, and `stopScreenShare` closes it. Remote producers still surface through
`sfu:producer-added`/`sfu:producer-removed`, and consumed tracks emit
`call:stream`. Leaving or ending the call closes the client transports,
producers, and consumers, and releases the server-side SFU resources.

## License

[MIT](../../LICENSE)
