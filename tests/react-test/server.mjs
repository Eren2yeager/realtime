import { createRealtimeServer } from "@realtime/server";

const realtime = createRealtimeServer({
  port: 3001,
  cors: { origin: "http://localhost:5173" },
  authenticate(request) {
    // Test-only identity. Production code must verify a session or token.
    const url = new URL(request.url, "http://localhost");
    const userId = url.searchParams.get("userId");
    if (!userId) throw new Error("A userId query parameter is required.");
    return { userId };
  },
  authorizeRoom: () => true
});

await realtime.start();
console.log("Realtime test server listening at http://localhost:3001");

const stop = async () => {
  await realtime.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
