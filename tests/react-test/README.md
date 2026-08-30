# React browser test (v0.7)

This is a local-only browser integration test for the v0.7 packages and runs
the realtime server through the `@realtimesdk/express` adapter with an SFU
media node (`@realtimesdk/sfu`). It uses query-string identities and permissive
room access solely to make testing easy.

For TURN testing, copy `.env.example` to `.env.local` and set
`VITE_METERED_ICE_SERVERS_URL` to Metered's credential-scoped ICE-server
endpoint. This test loads the returned STUN/TURN array before the realtime
client connects. Never use Metered's account secret in this variable.

From the repository root:

```bash
bun install
bun run build
```

In one terminal, start the realtime server (Node is required so the SFU's
mediasoup workers can start):

```bash
bun run test:express
```

In another, start Vite:

```bash
bun run test:react
```

Open `http://localhost:5173/?user=alice&callWith=bob` and
`http://localhost:5173/?user=bob&callWith=alice` in separate tabs. Both tabs
join `lobby`, where you can verify presence, typing indicators, messages, and
transport delivery events.

To test audio or video calling, open the two tabs above and, from Alice's tab, enter
`bob` (the query parameter pre-fills it) and click **Audio call** or **Video call**. The test app
uses the lobby to prepare the deterministic private room automatically, so Bob
does not need to join a room manually. Bob receives a normal incoming call and
can **Answer** or **Reject**; either participant can **Hang up**. Allow
microphone/camera access when prompted. An active call plays the remote audio
and renders remote video. Use **Share screen** during an active call to replace
your outgoing video with a display capture; stop it from the same control or
from the browser's share picker. A local HTTPS origin is required by browsers
that do not treat `localhost` as a secure context.

## Group calls (mesh)

To test full-mesh group calls, open at least three tabs (for example
`?user=alice`, `?user=bob`, and `?user=carol`), leave **Route group calls
through the SFU** unchecked, and click **Start group audio call** or **Start
group video call** from one tab. The call rings every other user connected to
the `lobby`; each tab shows an incoming group call with **Join** and **Reject**
controls. Joining connects that tab into the full-mesh call, where every
participant sees the other participants' remote streams, can **Share screen**
(which renegotiates with every peer), and can **Leave** without ending the call
for the others. Each call card shows a **mesh** media-path badge. The call ends
when the last participant leaves.

## Group calls (SFU)

To test SFU-routed group calls, open at least two tabs (for example
`?user=alice` and `?user=bob`), tick **Route group calls through the SFU**, and
click **Start group audio call** or **Start group video call** from one tab.
Enabling the toggle joins every tab into the `sfu-lobby` room; group calls
started while it is on use that room and route media through the SFU node.
Each call card shows an **SFU** media-path badge to confirm the route.

From the other tab, accept the ringing call with **Join** (or **Reject** to
decline). Both participants should see the remote audio/video streams under the
caller's ID. **Share screen** publishes a separate screen producer instead of
replacing the camera, so the caller keeps showing their camera while the other
participant sees a **screen share** block with the captured display. Use
**Stop sharing** to close the screen producer, and **Leave** when finished; the
SFU room is released once the last participant leaves.

The first SFU call lazily starts the mediasoup workers, so give it a moment.
Restart the server between mesh and SFU sessions only if you changed the
`useSfuForRoom` mapping in `server.mjs`.

Reload either tab while both are in the lobby to verify automatic room
restoration and the updated presence state. Press `Ctrl+C` in each terminal to
stop the test environment.

## Automated smoke tests

After the packages have been built, run:

```bash
node tests/smoke/v0.2-smoke-test.mjs
```

It verifies room presence, typing events, connected-recipient delivery events,
and automatic room restoration after a reconnect.

Run `node tests/smoke/v0.3-smoke-test.mjs` for the server-side call lifecycle
and signaling smoke test.

Run `node tests/smoke/v0.4-smoke-test.mjs` for video-call contract and
renegotiation signaling coverage.

Run `node tests/smoke/v0.7-client-sfu-smoke-test.mjs` for the end-to-end SFU
call flow (auto-wired setup, publish/consume, screen sharing, and cleanup).
Browser media capture and display sharing remain manual browser integration
checks.
