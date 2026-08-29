## Public Preview

# Realtime Platform (v0.6)

Framework-independent realtime rooms and messaging for browser clients and one Node.js server.

[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/core?label=%40realtimesdk%2Fcore)](https://www.npmjs.com/package/@realtimesdk/core)
[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/server?label=%40realtimesdk%2Fserver)](https://www.npmjs.com/package/@realtimesdk/server)
[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/client?label=%40realtimesdk%2Fclient)](https://www.npmjs.com/package/@realtimesdk/client)
[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/react?label=%40realtimesdk%2Freact)](https://www.npmjs.com/package/@realtimesdk/react)
[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/express?label=%40realtimesdk%2Fexpress)](https://www.npmjs.com/package/@realtimesdk/express)
[![npm (scoped)](https://img.shields.io/npm/v/@realtimesdk/next?label=%40realtimesdk%2Fnext)](https://www.npmjs.com/package/@realtimesdk/next)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## v0.6 capabilities

- Room-scoped online/offline presence, including a presence snapshot on join
- Typing start/stop events
- Automatic restoration of client-joined rooms after a reconnect
- `message:delivered` events for each connected recipient (transport delivery only)
- Browser navigation closes a client connection immediately, so presence does not wait for a heartbeat timeout
- Authenticated, room-authorized WebRTC offer, answer, and ICE-candidate signaling
- One-to-one browser audio calls, including accept, reject, hangup, ringing timeout, and disconnect handling
- One-to-one browser video calls and in-call screen sharing
- Group audio and video calls over a full-mesh peer topology, with in-call join/leave and group screen sharing
- Application-provided STUN/TURN (`iceServers`) configuration; media remains peer-to-peer

## Packages

- `@realtimesdk/core` – protocol contracts and shared helpers
- `@realtimesdk/server` – Socket.IO server with authentication and room authorization hooks
- `@realtimesdk/client` – browser client SDK
- `@realtimesdk/react` – thin React bindings over the client SDK
- `@realtimesdk/express` – Express HTTP server adapter
- `@realtimesdk/next` – Next.js custom HTTP server adapter

## Install and build

```bash
bun install
bun run build
```

Node.js 20 or newer is required. The repository intentionally does not commit dependencies.

## Server

Authentication and room authorization stay in the host application. The server
does not store messages or impose a data model.

```ts
import { createRealtimeServer } from "@realtimesdk/server";

const realtime = createRealtimeServer({
  port: 3001,
  authenticate: (request) => {
    // Verify the application's cookie, bearer token, or session here.
    return { userId: "user-123" };
  },
  authorizeRoom: ({ user, roomId, action }) => {
    // Look up membership/application policy here.
    return roomId.startsWith(`private:${user.userId}:`) || roomId === "lobby";
  }
});

await realtime.start();
```

To use an existing Node HTTP server, call `realtime.attach(httpServer)` before
the HTTP server begins listening.

## Express

The Express adapter creates one HTTP server for both the Express application
and realtime transport. Express remains a peer dependency.

```ts
import express from "express";
import { createExpressRealtime } from "@realtimesdk/express";

const app = express();
app.get("/health", (_request, response) => response.json({ ok: true }));
const server = createExpressRealtime(app, {
  port: 3001,
  authenticate: (request) => ({ userId: authenticateRequest(request) }),
  authorizeRoom: ({ user, roomId }) => canAccessRoom(user.userId, roomId)
});
await server.start();
```

## Browser client

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

The server verifies a `0.5` protocol handshake automatically. A user must join
a room before sending; message events are transport-only and are never persisted.

## Audio calls

Both users must have joined the same private or otherwise authorized room. The
server selects the single other user in that room, relays signaling only, and
never receives the audio stream.

```ts
const realtime = createRealtimeClient("http://localhost:3001", {
  iceServers: [
    { urls: "stun:stun.example.com:3478" },
    { urls: "turn:turn.example.com:3478", username: "temporary-user", credential: "temporary-secret" }
  ]
});

realtime.on("call:incoming", (call) => {
  // Show a ringing UI, then call realtime.answerAudioCall(call.id).
});
realtime.on("call:stream", (call, stream) => {
  // Attach stream to an <audio> element: audio.srcObject = stream.
});

const call = await realtime.startVideoCall("private:alice:bob");
// Later: await realtime.hangupCall(call.id)
```

During an active call, use `startScreenShare(call.id)` and `stopScreenShare(call.id)`.

`startCall`, `acceptCall`, `sendOffer`, `sendAnswer`, and `sendIceCandidate`
are also available for applications that manage their own `RTCPeerConnection`.

## Group calls (v0.6)

Group calls are room-scoped and ring every other authorized member of the
room instead of a single peer. Each participant joins or leaves independently;
the call ends when the last participant leaves.

```ts
const call = await realtime.startGroupCall("lobby", { video: true });

// Each invitee accepts independently:
await realtime.joinCall(call.id);
// Leave without ending the call for others:
await realtime.leaveCall(call.id);
```

Media is exchanged over a full-mesh peer topology — the server relays signaling
only and never receives the media stream. Screen sharing during a group call
uses `startScreenShare(call.id)` / `stopScreenShare(call.id)`.

For applications that manage their own `RTCPeerConnection`s, `startGroupCallRaw`
and `joinCallRaw` start or join a group call without acquiring media, and
`sendGroupOffer`, `sendGroupAnswer`, and `sendGroupIceCandidate` relay
point-to-point signaling between named participants.


## React

```tsx
import { RealtimeProvider, useChat } from "@realtimesdk/react";

function Chat() {
  const { messages, sendMessage } = useChat("lobby");
  return <button onClick={() => void sendMessage("Hello!")}>{messages.length}</button>;
}

export function App() {
  return <RealtimeProvider url="http://localhost:3001"><Chat /></RealtimeProvider>;
}
```

## Testing

Two test layers:

- **In-workspace smoke tests** — run against the local `dist/` after `bun run build`. Useful as a regression check after editing sources.

  ```bash
  bun install
  bun run build
  bun run test:smoke
  ```

  Runs `tests/smoke/v0.1-*` through `tests/smoke/v0.5-*` (messaging, presence, typing, calls, video, Express adapter, Next.js adapter).

- **Public-registry smoke test** — installs the packages from npmjs.org into `tests/smoke/public-registry/` and exercises them end-to-end. Use this to verify a freshly published release without workspace resolution.

  ```bash
  bun run test:smoke:public
  ```

## License

[MIT](./LICENSE)
