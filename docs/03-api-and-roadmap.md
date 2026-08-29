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
  calls,
  startAudioCall,
  answerAudioCall,
  rejectCall,
  hangupCall
} = useCall();

startAudioCall("private:alice:bob");
```

Calls are room-scoped. A one-to-one call uses a private room containing exactly
one other user; a group call rings every other authorized member of the room.
Each call entry exposes its lifecycle state and local/remote `MediaStream`
values when available.

```js
const {
  calls,
  startGroupCall,
  joinCall,
  leaveCall,
  hangupCall
} = useCall();

startGroupCall("lobby", { video: true }); // ring every other member of the room
joinCall(call.id);                        // accept an incoming group call
leaveCall(call.id);                       // leave without ending the call
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

### Version 0.1 — Complete

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

### Version 0.2 — Complete

Add:

- Presence
- Typing indicators
- Reconnection
- Message delivery events

### Version 0.3 — Complete

Delivered:

- WebRTC signaling
- One-to-one audio calls
- Configurable STUN/TURN ICE servers on the browser client

The calling API provides `startAudioCall`, `answerAudioCall`, `rejectCall`,
and `hangupCall`, with `startCall`, `acceptCall`, and signaling methods for
advanced integrations. Calls ring for 30 seconds by default (configurable on
the server), and end when a participant disconnects or leaves the room. TURN
credential issuance remains the host application's responsibility.

### Version 0.4 — Complete

Delivered:

- One-to-one browser video calls
- In-call screen sharing with WebRTC renegotiation
- Application-provided STUN/TURN ICE configuration (introduced in v0.3 and retained)

### Version 0.5 - complete

Add:

- Express adapter – complete
- Next.js integration

### Version 0.6 — Complete

Add:

- Group audio calls
- Group video calls
- In-call participant join/leave
- Group screen sharing
- Full-mesh WebRTC topology for group media

Group calls are room-scoped and ring every other authorized member of the
room, removing the one-to-one "exactly one other user" requirement. Each
participant joins or leaves independently while the call is active, and the
call ends when the last participant leaves. The server relays signaling only;
media stays peer-to-peer over a full-mesh topology.

### Version 0.7 — In Progress

Add:

- A new `@realtimesdk/sfu` package: a self-hosted media-routing node for large group calls
- Hub-and-spoke group media topology as an alternative to full-mesh
- Application-provided SFU configuration on both server and client
- Fallback to full-mesh when no SFU is configured
- SFU signaling contracts in `@realtimesdk/core` (transport/produce/consume request-response events)
- A client SFU participant module in `@realtimesdk/client` (`setupSfuCall`, `publishSfuTrack`, `consumeSfuProducer`) that connects over mediasoup WebRTC transports and auto-wires into `startGroupCall`/`joinCall` for SFU-mode rooms

Version 0.7 moves large-room group media from a full-mesh topology to a
selective-forwarding unit (SFU). Each participant sends their media to the SFU,
which selectively forwards it to the other participants, so group calls scale
beyond what a full mesh can support. The realtime server continues to own
signaling, room authorization, and call lifecycle; the SFU forwards media only
and remains the application's infrastructure to provision and configure.
Full-mesh stays the default for small rooms and for deployments without an SFU,
keeping the platform's bring-your-own-infrastructure philosophy.

The SFU is built on **mediasoup**, used as a library rather than a platform.
mediasoup provides the WebRTC media-routing primitives (Worker, Router,
Transport, Producer, Consumer) but no signaling, authentication, or client SDK,
so the platform keeps owning the protocol, room authorization, call lifecycle,
and browser client. Package responsibilities split as follows:

- `@realtimesdk/sfu` — wraps one or more mediasoup Workers, owns one Router per
  room, and exposes publish/subscribe to the realtime server.
- `@realtimesdk/server` — a thin coordinator that assigns a room to an SFU and
  hands clients their publish/subscribe endpoints; signaling and authorization
  stay in the server.
- `@realtimesdk/client` — an SFU participant module that connects to the
  assigned SFU over a mediasoup WebRTC Transport, publishes local media via a
  Producer, and receives forwarded media via a Consumer.

This keeps `@realtimesdk/server` free of the media router's heavy native
dependencies, allows the SFU to be provisioned and scaled independently, and
leaves room for running multiple SFU nodes behind a single signaling server.
 
### Later

Potential features:

- Redis-backed horizontal scaling
- Custom transports
- Storage adapters
- Advanced authorization
- Moderation hooks
- Analytics hooks
- CLI initialization


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
