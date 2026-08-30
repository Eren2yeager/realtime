# Changelog

All notable changes to the Realtime Platform are documented here, grouped by
released version. Per-package changelogs are generated automatically by
Changesets for future releases.

## 0.7.0 (2026)

### Added

- `@realtimesdk/sfu`: a self-hosted media-routing node for large group calls, built on mediasoup and used as a library.
- Hub-and-spoke group media topology as an alternative to full-mesh; full-mesh remains the default when no SFU is configured.
- Application-provided SFU configuration on both the server and the client.
- SFU signaling contracts in `@realtimesdk/core`.
- A client SFU participant module in `@realtimesdk/client` (`setupSfuCall`, `publishSfuTrack`, `consumeSfuProducer`).

## 0.6.0

### Added

- Group audio and video calls over a full-mesh peer topology.
- In-call participant join/leave.
- Group screen sharing.
- Calls end when the last participant leaves.

## 0.5.0

### Added

- Express adapter (`@realtimesdk/express`).
- Next.js custom HTTP server adapter (`@realtimesdk/next`).

## 0.4.0

### Added

- One-to-one browser video calls.
- In-call screen sharing with WebRTC renegotiation.

## 0.3.0

### Added

- WebRTC signaling.
- One-to-one audio calls.
- Configurable STUN/TURN ICE servers on the browser client.

## 0.2.0

### Added

- Presence.
- Typing indicators.
- Reconnection.
- Message delivery events.

## 0.1.0

### Added

- Core client and server packages.
- Socket-based transport.
- Rooms and one-to-one chat.
- React integration.
