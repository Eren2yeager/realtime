# Realtime Platform (v0.2)

Framework-independent realtime rooms and messaging for browser clients and one Node.js server.

## v0.2 capabilities

- Room-scoped online/offline presence, including a presence snapshot on join
- Typing start/stop events
- Automatic restoration of client-joined rooms after a reconnect
- `message:delivered` events for each connected recipient (transport delivery only)
- Browser navigation closes a client connection immediately, so presence does not wait for a heartbeat timeout

## Packages

- `@realtime/core` – protocol contracts and shared helpers
- `@realtime/server` – Socket.IO server with authentication and room authorization hooks
- `@realtime/client` – browser client SDK
- `@realtime/react` – thin React bindings over the client SDK

## Install and build

```bash
npm install
npm run build
```

Node.js 20 or newer is required. The repository intentionally does not commit dependencies.

## Server

Authentication and room authorization stay in the host application. The server
does not store messages or impose a data model.

```ts
import { createRealtimeServer } from "@realtime/server";

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

## Browser client

```ts
import { createRealtimeClient } from "@realtime/client";

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

The server verifies a `0.1` protocol handshake automatically. A user must join
a room before sending; message events are transport-only and are never persisted.

## React

```tsx
import { RealtimeProvider, useChat } from "@realtime/react";

function Chat() {
  const { messages, sendMessage } = useChat("lobby");
  return <button onClick={() => void sendMessage("Hello!")}>{messages.length}</button>;
}

export function App() {
  return <RealtimeProvider url="http://localhost:3001"><Chat /></RealtimeProvider>;
}
```
