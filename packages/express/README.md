# @realtimesdk/express

[![npm version](https://img.shields.io/npm/v/@realtimesdk/express.svg)](https://www.npmjs.com/package/@realtimesdk/express)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Express HTTP server adapter that hosts the [`@realtimesdk/server`](../server) transport alongside your Express app on a single Node.js HTTP server.

`express` (>= 4.18) is a peer dependency.

## Install

```bash
npm install @realtimesdk/express express
```

## Usage

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

The Express request handler and the realtime transport share one HTTP server, so Socket.IO upgrades, long polling fallbacks, and HTTP health checks all flow through the same port.

## License

[MIT](../../LICENSE)
