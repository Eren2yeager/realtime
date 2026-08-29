# @realtimesdk/sfu

[![npm version](https://img.shields.io/npm/v/@realtimesdk/sfu.svg)](https://www.npmjs.com/package/@realtimesdk/sfu)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Self-hosted media-routing node (SFU) for large realtime group calls, built on
[mediasoup](https://mediasoup.org/) as a library. Forwards media only — it does
not own signaling, authentication, or call lifecycle. Those stay with
[`@realtimesdk/server`](../server), which assigns rooms to the SFU and hands
clients their publish/subscribe endpoints.

## Install

```bash
npm install @realtimesdk/sfu
```

## Usage

```ts
import { createSfuNode } from "@realtimesdk/sfu";

const sfu = createSfuNode({ listenIps: [{ ip: "0.0.0.0" }] });
await sfu.start();

const room = await sfu.createRoom("lobby");
const transport = await room.createTransport({ direction: "send" });
// Relay `transport` to the peer, then connect and publish:
await room.connectTransport(transport.transportId, dtlsParameters);
const producer = await room.produce({ transportId: transport.transportId, kind: "video", rtpParameters });
```

Full-mesh remains the default for small rooms and when no SFU is configured.

This package must run under **Node.js** (mediasoup does not support bun).

## License

[MIT](../../LICENSE)
