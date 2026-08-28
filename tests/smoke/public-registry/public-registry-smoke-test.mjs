/* eslint-disable no-console */
import assert from "node:assert/strict";

const { createRealtimeClient } = await import("@realtimesdk/client");
const { createExpressRealtime } = await import("@realtimesdk/express");
const { directRoomId, PROTOCOL_VERSION } = await import("@realtimesdk/core");

assert.equal(PROTOCOL_VERSION, "0.5", "PROTOCOL_VERSION should be 0.5");
assert.equal(directRoomId("a", "b"), "dm:a:b", "directRoomId helper mismatch");

const app = (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404).end();
};

const server = createExpressRealtime(app, {
  port: 0,
  authenticate: (request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    return { userId: url.searchParams.get("userId") ?? `anon-${Math.random().toString(36).slice(2, 8)}` };
  },
  authorizeRoom: ({ user, roomId }) => roomId === "public-smoke-room" || roomId.startsWith(`private:${user.userId}:`)
});

await server.start();
const port = server.httpServer.address().port;
const url = `http://127.0.0.1:${port}`;
console.log(`Server listening on ${url}`);

let exitCode = 0;
try {
  const healthRes = await fetch(`${url}/health`);
  assert.equal(healthRes.status, 200, "/health should respond");
  assert.deepEqual(await healthRes.json(), { ok: true });
  console.log("✔ Express /health endpoint reachable");

  const alice = createRealtimeClient(`${url}?userId=alice`);
  const bob = createRealtimeClient(`${url}?userId=bob`);
  const roomId = "public-smoke-room";

  const waitFor = (client, event) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}`)), 8_000);
      const off = client.on(event, (...args) => { clearTimeout(timer); off(); resolve(args); });
    });

  alice.connect();
  bob.connect();

  const bobMessageReceived = waitFor(bob, "message");

  await Promise.all([waitFor(alice, "connected"), waitFor(bob, "connected")]);
  await Promise.all([alice.joinRoom(roomId), bob.joinRoom(roomId)]);

  await alice.sendMessage(roomId, "hello from npm");
  const [received] = await bobMessageReceived;
  assert.equal(received.roomId, roomId);
  assert.equal(received.senderId, "alice");
  assert.equal(received.content, "hello from npm");
  console.log("✔ Cross-client messaging via published packages works");

  const directRoom = directRoomId("alice", "bob");
  assert.ok(directRoom.startsWith("dm:"), "direct room id format");
  console.log(`✔ directRoomId helper resolves to ${directRoom}`);

  alice.destroy();
  bob.destroy();
  console.log("\n✅ public-registry smoke test passed");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
  process.exit(exitCode);
}
