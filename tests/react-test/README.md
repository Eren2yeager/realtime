# React browser test

This is a local-only browser integration test for the v0.1 packages. It uses
query-string identities and permissive room access solely to make testing easy.

From the repository root:

```bash
npm install
npm run build
```

In one terminal, start the realtime server:

```bash
npm run test:react-server
```

In another, start Vite:

```bash
npm run test:react
```

Open `http://localhost:5173/?user=alice` and
`http://localhost:5173/?user=bob` in separate tabs. Both tabs join `lobby`.
Messages sent from either tab should appear in both tabs with the correct
sender identity. Press `Ctrl+C` in each terminal to stop the test environment.

## v0.2 smoke test

After the packages have been built, run:

```bash
node tests/v0.1/v0.2-smoke-test.mjs
```

It verifies room presence, typing events, connected-recipient delivery events,
and automatic room restoration after a reconnect.
