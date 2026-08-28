import { createNextRealtime } from "@realtime/next";
import { createRealtimeClient } from "@realtime/client";
const app = (request, response) => {
  if (request.url === "/health") {
    response.writeHead(200);
    response.end("next-ok");
    return;
  }
  response.writeHead(404);
  response.end();
};
const server = createNextRealtime(app, {
  port: 3006,
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
  const health = await fetch("http://localhost:3006/health");
  if ((await health.text()) !== "next-ok")
    throw new Error("Next route unavailable");
  const alice = createRealtimeClient("http://localhost:3006?userId=alice");
  const bob = createRealtimeClient("http://localhost:3006?userId=bob");
  const connected = Promise.all([
    waitFor(alice, "connected"),
    waitFor(bob, "connected"),
  ]);
  alice.connect();
  bob.connect();
  await connected;
  await Promise.all([alice.joinRoom("next-room"), bob.joinRoom("next-room")]);
  const received = waitFor(bob, "message");
  await alice.sendMessage("next-room", "Hello through Next.js");
  if ((await received).content !== "Hello through Next.js")
    throw new Error("Message delivery failed");
  alice.destroy();
  bob.destroy();
  console.log("✅ v0.5 Next.js adapter smoke test passed");
} catch (error) {
  console.error(error);
  exitCode = 1;
} finally {
  await server.close();
}
process.exit(exitCode);
