import express from "express";
import { createExpressRealtime } from "@realtimesdk/express";
import { createSfuNode } from "@realtimesdk/sfu";

const app = express();
app.get("/health", (_request, response) => response.json({ ok: true }));

// The SFU worker starts lazily on the first group call to the sfu-lobby room.
const sfu = createSfuNode({ listenIps: [{ ip: "127.0.0.1" }] });

const server = createExpressRealtime(app, {
  port: 3000,
  cors: { origin: "http://localhost:5173" },
  sfu,
  useSfuForRoom: (roomId) => roomId === "sfu-lobby",
  authenticate(request) {
    // Test-only identity. Production code must verify a session or token.
    const url = new URL(request.url, "http://localhost");
    const userId = url.searchParams.get("userId");
    if (!userId) throw new Error("A userId query parameter is required.");
    return { userId };
  },
  authorizeRoom: () => true
});

await server.start();
console.log("Realtime test server listening at http://localhost:3000");

const stop = async () => {
  await server.close();
  await sfu.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
