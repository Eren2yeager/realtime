# Realtime Communication Platform — Architecture

## 1. High-Level Architecture

```text
                         Realtime Platform
                                |
              +-----------------+-----------------+
              |                                   |
          Client Layer                        Server Layer
              |                                   |
       +------+-------+                    +------+-------+
       |              |                    |              |
      Core          Framework           Transport      WebRTC
      SDK           Adapters              Layer        Signaling
       |              |                    |              |
       |        React / Next.js /          |         Offer/Answer
       |        Vanilla JS                |         ICE Candidates
       |                                   |
       +-------------------+---------------+
                           |
                       Event API
                           |
                    Developer Application
                           |
                    Developer Database
```

## 2. Package Structure

Proposed package family:

```text
@yourorg/realtime-core       Shared protocol, event definitions, and types
@yourorg/realtime-client
@yourorg/realtime-server
@yourorg/realtime-react
@yourorg/realtime-next
@yourorg/realtime-express
```

A CLI may eventually be provided as:

```text
@yourorg/realtime-cli
```

## 3. Core Package

The core package is a shared, runtime-light contract package. It contains:

- Event names and payload types
- Protocol and compatibility information
- Shared error codes
- Shared room, identity, message, and call types

It must not own browser, Node.js, React, Express, Socket.IO, or WebRTC runtime
behavior. Those belong in the client and server packages.

## 4. Client Architecture

```text
React / Next.js / Vanilla JS
            |
       Framework Adapter
            |
       Client SDK
            |
      Transport Layer
            |
       Realtime Server
```

React should be an adapter around the core client rather than the foundation of the platform.

## 5. Server Architecture

The server should support two modes.

### Standalone

```js
const realtime = createRealtimeServer({
  port: 3001
});

realtime.start();
```

The package creates and owns the server.

### Attached

```js
const realtime = createRealtimeServer();

realtime.attach(server);
```

The developer supplies an existing HTTP server.

This is important for Express and custom Node.js applications.

## 6. Transport

Socket.IO may be used as the initial transport implementation, but it should not define the public abstraction of the entire platform.

The core should expose concepts such as:

```text
connect()
disconnect()
send()
emit()
on()
joinRoom()
leaveRoom()
```

This leaves room for future transport implementations.

For version 0.1, the transport is socket-based and runs against one Node.js
server instance. The public server design should isolate runtime state and
message publication behind internal adapters so shared-state implementations
can be added later without changing the public API.

## 7. WebRTC Flow

```text
Client A
   |
   | createOffer()
   |
   |---- offer ----> Signaling Server ----> Client B
                                             |
                                             | setRemoteDescription()
                                             | createAnswer()
                                             |
   |<--- answer ---- Signaling Server <------|
   |
   |<---------- ICE candidates ------------>|
   |
   +========== WebRTC media connection =====+
                  |
             Audio / Video
             Screen Share
```

The realtime server normally handles signaling, not the actual media stream.

One-to-one calls use the private room's single peer. Group calls reuse the same
signaling flow in a full-mesh topology: every participant exchanges
offer/answer and ICE candidates with every other participant, while the realtime
server relays signaling only. A dedicated media server (SFU) is not part of
version 0.6; mesh keeps the server out of the media path and is appropriate
for small-to-medium rooms.

## 8. STUN and TURN

STUN is used to discover viable network addresses.

TURN is used as a relay when a direct peer-to-peer connection cannot be established.

The platform should expose configurable ICE server settings rather than forcing a specific provider.

## 9. Database Boundary

The platform must not require a database.

Application persistence should remain outside the core package.

Example:

```js
realtime.on("message", async (message) => {
  await db.messages.create({
    sender: message.senderId,
    body: message.content,
    room: message.roomId
  });
});
```

The realtime package produces events; the application decides how those events are persisted.

Transport delivery acknowledgement may be provided by the platform. Read
receipts are application events, because the application determines what
constitutes a message being read.

## 10. Runtime State vs Persistent Data

Runtime state may include:

- Connected sockets
- Active rooms
- Presence
- Current calls
- WebRTC signaling state

Persistent application data may include:

- Messages
- User profiles
- Call history
- Moderation records
- Analytics

These concerns should remain separate.

## 11. Authentication Boundary

The platform should provide authentication hooks rather than forcing a new authentication system.

Possible future API:

```js
createRealtimeServer({
  authenticate: async (request) => {
    return getExistingUser(request);
  }
});
```

The developer remains responsible for identity and authorization policy.

For the initial contract, authentication returns a stable identity for the
connection:

```ts
type AuthenticatedUser = {
  userId: string;
  metadata?: Record<string, unknown>;
};
```

The server should also provide a room authorization hook, called for joins and
room-scoped actions. It receives the authenticated user, room ID, and action,
and permits or rejects the action. Client-supplied user IDs must never be
trusted as identity.

## 12. Room and Direct-Message Model

Rooms are server-authoritative. The application controls membership through
the authorization hook.

A one-to-one conversation is a private room with a deterministic ID derived
from its two participants, for example by sorting their user IDs. The client
may expose a helper to create this ID, but direct messaging remains a room
convention rather than a separate subsystem.

## 13. Protocol Contracts

Before public APIs stabilize, every event must define its payload, validation,
acknowledgement result, error code, and ordering expectation. The client and
server perform a version handshake so incompatible package versions fail
clearly rather than producing silent event mismatches.
