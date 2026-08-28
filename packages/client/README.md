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

## License

[MIT](../../LICENSE)
