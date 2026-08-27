# React browser test (v0.4)

This is a local-only browser integration test for the v0.4 packages and runs
the realtime server through the `@realtime/express` adapter. It uses
query-string identities and permissive room access solely to make testing easy.

For TURN testing, copy `.env.example` to `.env.local` and set
`VITE_METERED_ICE_SERVERS_URL` to Metered's credential-scoped ICE-server
endpoint. This test loads the returned STUN/TURN array before the realtime
client connects. Never use Metered's account secret in this variable.

From the repository root:

```bash
bun install
bun run build
```

In one terminal, start the realtime server:

```bash
bun run test:react-server
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
renegotiation signaling coverage. Browser media capture and display sharing
remain manual browser integration checks.
