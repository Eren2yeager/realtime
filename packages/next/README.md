# @realtimesdk/next

[![npm version](https://img.shields.io/npm/v/@realtimesdk/next.svg)](https://www.npmjs.com/package/@realtimesdk/next)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Next.js custom HTTP server adapter that hosts the [`@realtimesdk/server`](../server) transport during the Next.js server lifecycle.

`next` (>= 13) is a peer dependency.

## Install

```bash
npm install @realtimesdk/next next
```

## Usage

```js
import next from "next";
import { createNextRealtime } from "@realtimesdk/next";

const app = next({ dev: process.env.NODE_ENV !== "production" });
await app.prepare();

const server = createNextRealtime(app.getRequestHandler(), {
  authenticate: (request) => ({ userId: "user-123" }),
  authorizeRoom: () => true,
});

await server.start(3000);
```

The Next.js request handler and the realtime transport share one HTTP server, so Socket.IO upgrades, polling fallbacks, and HTTP routes all flow through the same port.

## License

[MIT](../../LICENSE)
