# @realtimesdk/server

[![npm version](https://img.shields.io/npm/v/@realtimesdk/server.svg)](https://www.npmjs.com/package/@realtimesdk/server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Socket.IO realtime server with authentication and room authorization hooks.

This package owns:

- The Socket.IO transport
- Room and presence state
- Call lifecycle and WebRTC signaling relay
- Reconnection bookkeeping

It does not store messages or impose a data model — the host application controls authentication, authorization, and persistence through hooks.

## Install

```bash
npm install @realtimesdk/server
```

## Standalone usage

```ts
import { createRealtimeServer } from "@realtimesdk/server";

const realtime = createRealtimeServer({
  port: 3001,
  authenticate: (request) => ({ userId: "user-123" }),
  authorizeRoom: ({ user, roomId, action }) => roomId.startsWith(`private:${user.userId}:`) || roomId === "lobby",
});

await realtime.start();
```

## Attach to an existing HTTP server

```ts
import { createServer } from "node:http";
import { createRealtimeServer } from "@realtimesdk/server";

const httpServer = createServer();
const realtime = createRealtimeServer({
  authenticate: (request) => ({ userId: "user-123" }),
  authorizeRoom: () => true,
});
realtime.attach(httpServer);
httpServer.listen(3001);
```

## Security (recommended for production)

Add origin validation, rate limiting, and a bounded packet size to harden the
server against cross-site WebSocket hijacking and abuse:

```ts
const realtime = createRealtimeServer({
  port: 3001,
  authenticate: (request) => ({ userId: "user-123" }),
  authorizeRoom: () => true,

  // Only accept browser connections from these origins. Requests without an
  // Origin header (e.g. non-browser clients) are allowed unless the option is a
  // function that rejects them. A RegExp or a function is also supported.
  origin: ["https://app.example.com"],

  // Allow at most 100 inbound events per second per connection.
  rateLimit: { windowMs: 1000, max: 100 },

  // Reject packets larger than 1 MB.
  maxHttpBufferSize: 1_000_000,
});

await realtime.start();
```

- `origin` — `string`, `string[]`, `RegExp`, or `(origin) => boolean`. Validated on
  every handshake; rejections close the connection before it is usable.
- `rateLimit` — per-connection sliding window (`windowMs`/`max`). Exceeding it
  returns a `RATE_LIMITED` error for the offending events.
- `maxHttpBufferSize` — maximum incoming packet size in bytes (default 1 MB).

These options are off by default so existing deployments are unaffected; enable
them in production.

## SFU media routing (v0.7)

Optionally route large group calls through a media-routing node built on
mediasoup. Provide an SFU node (satisfying the server's `SfuNodeHandle`
structurally — `createSfuNode` from `@realtimesdk/sfu` fits) and choose which
rooms use it:

```ts
import { createRealtimeServer } from "@realtimesdk/server";
import { createSfuNode } from "@realtimesdk/sfu";

const realtime = createRealtimeServer({
  port: 3001,
  authenticate: (request) => ({ userId: "user-123" }),
  authorizeRoom: () => true,
  sfu: createSfuNode({ listenIps: [{ ip: "0.0.0.0" }] }),
  useSfuForRoom: (roomId) => roomId.startsWith("large:"),
});

await realtime.start();
```

Group calls in SFU rooms advertise `mediaMode: "sfu"`; the server relays
publish/subscribe signaling between the SFU and clients. Rooms that do not use
the SFU keep the full-mesh topology. The SFU must run under Node.js (mediasoup
does not support bun).

## License

[MIT](../../LICENSE)
