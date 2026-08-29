# Realtime Communication Platform — Project Vision & Requirements

## 1. Project Overview

A framework-independent realtime communication platform that makes it easy for developers to add:

- Real-time chat
- User presence
- Typing indicators
- Audio calls
- Video calls
- Screen sharing / streaming
- WebRTC signaling
- Connection and reconnection handling

The platform should abstract away the difficult realtime/WebRTC infrastructure while preserving developer freedom over application architecture, authentication, and persistence.

## 2. Core Philosophy

### Bring Your Own Database
The platform must not require or impose a database.

Developers may:
- Use no persistence at all.
- Persist data themselves using their existing database.
- Connect the platform to custom storage adapters in the future.

The platform should never impose a fixed application database schema.

### Bring Your Own Framework
The core should not depend on React, Next.js, Express, or another framework.

Initial integrations should target:
- React
- Next.js
- Express
- Vanilla JavaScript where practical

### Realtime Infrastructure as the Product
The platform owns realtime communication concerns:
- Connections
- Rooms
- Presence
- Messaging transport
- WebRTC signaling
- Calls
- Streaming
- Reconnection
- Realtime events

The developer owns:
- Application models
- Database persistence
- Business rules
- Authorization policies
- Existing authentication systems

For version 0.1, authentication establishes an immutable `userId` for each
connection. The application is also responsible for deciding whether that user
may join a room or perform a room-scoped action.

## 3. Target Developer Experience

A developer should be able to install the package and get realtime functionality with minimal setup.

Example:

```bash
npm install @yourorg/realtime-client
npm install @yourorg/realtime-server
```

Or eventually:

```bash
npx realtime init
```

The CLI should detect the framework and generate the appropriate integration.

## 4. Main Features

### Chat
- One-to-one messaging
- Room/group messaging
- Message events
- Delivery state events
- Typing indicators
- Online/offline presence

### Calling
- One-to-one audio calls
- One-to-one video calls
- Group audio calls
- Group video calls
- In-call participant join/leave
- Call accept/reject
- Hang up
- Call state management

### Streaming
- Screen sharing
- Camera streaming
- Microphone streaming
- Future support for group streaming

### WebRTC
- Peer connection lifecycle
- Offer/answer exchange
- ICE candidate exchange
- STUN configuration
- TURN configuration
- Connection failure/recovery

### Server
- WebSocket/realtime transport
- Signaling
- Rooms
- Presence
- Event system
- Authentication hooks
- Framework adapters

## 5. Non-Goals

The first version should NOT attempt to become:
- A database platform
- A full authentication provider
- A video storage platform
- A social network backend
- A replacement for an entire application backend
- A horizontally scaled, multi-node realtime deployment
- A mobile or server-side client runtime

## 6. Success Criteria

The project is successful when a developer can add basic chat and calling without manually implementing:
- Socket event protocols
- WebRTC offer/answer handling
- ICE candidate handling
- Peer connection lifecycle
- Reconnection logic

while still retaining control over their application data and architecture.

## 7. Version 0.1 Scope Decisions

Version 0.1 targets a browser client and a single Node.js server. Runtime state
is held in memory. The server architecture should leave room for future shared
state and pub/sub adapters, but Redis or another scaling solution is not part
of this release.

The initial packages are TypeScript-based and published as ESM. CommonJS,
React Native, and server-side client support are deferred until concrete
integration requirements justify them.

Direct messages are represented as private rooms. A helper may create a stable
room ID from two user IDs; they are not a separate persistence or messaging
subsystem.
