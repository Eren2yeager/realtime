# @realtimesdk/core

[![npm version](https://img.shields.io/npm/v/@realtimesdk/core.svg)](https://www.npmjs.com/package/@realtimesdk/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Shared protocol contracts, event types, and helpers for the realtimesdk platform.

This package is runtime-light and contains:

- Protocol and compatibility information (`PROTOCOL_VERSION`)
- Event names and payload types
- Shared error codes
- Shared room, identity, message, and call types
- The `directRoomId(firstUserId, secondUserId)` helper for deterministic DM room IDs

It does not depend on Socket.IO, React, Express, or any browser/Node.js runtime feature.

## Install

```bash
npm install @realtimesdk/core
```

## Usage

```ts
import { PROTOCOL_VERSION, directRoomId, type RealtimeMessage } from "@realtimesdk/core";

console.log(PROTOCOL_VERSION); // "0.7"
const roomId = directRoomId("alice", "bob"); // "dm:alice:bob"
```

## License

[MIT](../../LICENSE)
