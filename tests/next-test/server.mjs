import next from "next";
import { fileURLToPath } from "node:url";
import { createNextRealtime } from "@realtime/next";

const projectDir = fileURLToPath(new URL(".", import.meta.url));
const nextApp = next({ dev: true, dir: projectDir });
await nextApp.prepare();

const server = createNextRealtime(nextApp.getRequestHandler(), {
  port: Number(process.env.PORT ?? 3000),
  cors: { origin: "http://localhost:5173" },
  authenticate: (request) => ({
    userId: new URL(request.url ?? "/", "http://localhost").searchParams.get("userId") ?? "anonymous"
  }),
  authorizeRoom: () => true
});

await server.start();
console.log("Next.js + realtime listening at http://localhost:3000");

const stop = async () => {
  await server.close();
  await nextApp.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
