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
  authorizeRoom: ({ user, roomId, action }) =>
    roomId.startsWith(`private:${user.userId}:`) || roomId === "lobby"
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
  authorizeRoom: () => true
});
realtime.attach(httpServer);
httpServer.listen(3001);
```

## License

[MIT](../../LICENSE)
