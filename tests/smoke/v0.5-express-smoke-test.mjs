import { createExpressRealtime } from "@realtimesdk/express";
import { createRealtimeClient } from "@realtimesdk/client";

const app = (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200);
    response.end("ok");
    return;
  }
  response.writeHead(404);
  response.end();
};
const server = createExpressRealtime(app, {
  port: 3005,
  authenticate: (request) => ({
    userId:
      new URL(request.url ?? "/", "http://localhost").searchParams.get(
        "userId",
      ) ?? "anonymous",
  }),
  authorizeRoom: () => true,
});
const waitFor = (client, event) =>
  new Promise((resolve) => client.on(event, resolve));
let exitCode = 0;
try {
  await server.start();
  const health = await fetch("http://localhost:3005/health");
  if (!health.ok) throw new Error("Express route unavailable");
  const alice = createRealtimeClient("http://localhost:3005?userId=alice");
  const bob = createRealtimeClient("http://localhost:3005?userId=bob");
  const connected = Promise.all([
    waitFor(alice, "connected"),
    waitFor(bob, "connected"),
  ]);
  alice.connect();
  bob.connect();
  await connected;
  await Promise.all([
    alice.joinRoom("express-room"),
    bob.joinRoom("express-room"),
  ]);
  const received = waitFor(bob, "message");
  await alice.sendMessage("express-room", "Hello through Express");
  if ((await received).content !== "Hello through Express")
    throw new Error("Message delivery failed");
  alice.destroy();
  bob.destroy();
  console.log("✅ v0.5 Express adapter smoke test passed");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
