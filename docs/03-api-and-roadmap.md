# Realtime Communication Platform — API Direction & Roadmap

## 1. API Design Principles

The public API should be:
- Small
- Predictable
- Framework-independent
- Event-driven
- Type-safe where possible
- Easy to learn
- Difficult to misuse

The initial implementation is TypeScript and ESM-first. The public API must
not expose Socket.IO objects or event names as its primary abstraction.

## 2. Proposed Client API

### Chat

```js
const { messages, sendMessage } = useChat("room-123");

sendMessage("Hello!");
```

### Calling

```js
const {
  call,
  answer,
  reject,
  hangup,
  remoteStream
} = useCall();

call(userId);
```

### Screen Sharing

```js
const {
  startScreenShare,
  stopScreenShare
} = useScreenShare();

startScreenShare();
```

### Rooms

```js
const room = realtime.joinRoom("room-123");

room.on("message", handler);
room.on("user:joined", handler);
room.on("user:left", handler);
```

These APIs are directional examples and should be validated through implementation prototypes before becoming stable.

## 3. Proposed Server API

```js
const realtime = createRealtimeServer();

realtime.attach(server);

realtime.on("message", handler);
realtime.on("call:started", handler);
realtime.on("call:ended", handler);
realtime.on("user:online", handler);
realtime.on("user:offline", handler);
```

## 4. Event Categories

### Connection

```text
connection
disconnect
reconnect
error
```

### Presence

```text
user:online
user:offline
user:away
```

### Chat

```text
message
message:delivered
message:read
typing:start
typing:stop
```

### Calls

```text
call:started
call:ringing
call:accepted
call:rejected
call:ended
call:failed
```

### WebRTC

```text
webrtc:offer
webrtc:answer
webrtc:ice-candidate
webrtc:connection-state
```

These event names are provisional.

Each stabilized event must document:

- Its payload schema
- Whether it has an acknowledgement and its success value
- Its possible error codes
- Its delivery and ordering expectations

`message:delivered` means transport delivery to a connected recipient; it does
not imply persistence or that a user has read the message. Applications emit
read-state events according to their own product rules.

## 5. CLI Direction

Eventually:

```bash
npx realtime init
```

Possible prompts:

```text
Framework:
- Next.js
- Express
- React
- Vanilla JS

Features:
- Chat
- Presence
- Audio
- Video
- Screen sharing

Authentication:
- Existing authentication
- Custom integration
```

The CLI should generate configuration and integration code rather than hiding the entire architecture.

## 6. Initial MVP

### Version 0.1

Focus only on:

- Core client
- Core server
- Socket-based transport
- Rooms
- One-to-one chat
- Basic events
- React integration

Version 0.1 supports browser clients connected to a single Node.js server with
in-memory runtime state. It does not include Redis-backed scaling, React
Native, server-side clients, or CommonJS distribution.

Authentication establishes a stable user ID during the connection handshake.
Room joins and room-scoped actions are authorized by an application-provided
server callback. Direct messages use private, deterministic room IDs rather
than a dedicated direct-message subsystem.

### Version 0.2

Add:

- Presence
- Typing indicators
- Reconnection
- Message delivery events

### Version 0.3

Add:

- WebRTC signaling
- One-to-one audio calls
- STUN configuration

The calling API should provide high-level operations such as `call`, `answer`,
and `hangup`, while retaining a narrowly scoped, transport-agnostic advanced
signaling interface. A production-ready calling release requires a defined
call-session state machine, cancellation and timeout behavior, and a TURN
credential strategy.

### Version 0.4

Add:

- Video calls
- Screen sharing
- TURN configuration

### Version 0.5

Add:

- Express adapter
- Next.js integration
- CLI initialization

### Later

Potential features:

- Group calls
- Redis-backed horizontal scaling
- Custom transports
- Storage adapters
- Advanced authorization
- Moderation hooks
- Analytics hooks

## 7. Important Engineering Risks

### WebRTC complexity
Peer connection failures, NAT traversal, browser differences, and TURN requirements will require significant testing.

### Scaling
A single realtime server is easy; multiple instances require shared state and coordination.

### Framework compatibility
Next.js server/runtime differences need careful handling.

### API stability
The package should avoid exposing low-level Socket.IO/WebRTC details unless necessary.

### Security
Authentication, authorization, room access, origin validation, abuse prevention, and rate limiting must be considered from the beginning.

## 8. First Technical Milestone

Before building the full product, implement a minimal prototype:

```text
React Client A
      |
      | Socket
      |
Realtime Server
      |
      | Socket
      |
React Client B
```

Verify:

1. Connect/disconnect
2. User identity
3. Room joining
4. Message sending
5. Message events
6. Presence

Then add WebRTC:

```text
A -> offer -> server -> B
A <- answer <- server <- B
A <-> ICE candidates <-> B
A <========== WebRTC ==========> B
```

Only after this works reliably should the public API be stabilized.

## 9. Long-Term Product Definition

The platform should ultimately be understood as:

> A framework-independent realtime communication layer that provides chat, presence, calling, and streaming while allowing developers to keep control of their own database, authentication, business logic, and application architecture.
