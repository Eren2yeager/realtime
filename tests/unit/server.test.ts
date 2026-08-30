import { afterEach, describe, expect, test } from "bun:test";
import { io, type Socket } from "socket.io-client";
import { PROTOCOL_VERSION, type Result } from "../../packages/core/src/index.ts";
import {
  createRealtimeServer,
  type RealtimeServer,
  type RealtimeServerOptions,
} from "../../packages/server/src/index.ts";

type Harness = {
  server: RealtimeServer;
  port: number;
  clients: Socket[];
  close: () => Promise<void>;
};

const harnesses: Harness[] = [];

async function startServer(overrides: Partial<RealtimeServerOptions> = {}): Promise<Harness> {
  const server = createRealtimeServer({
    port: 0,
    authenticate: (request) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      return { userId: url.searchParams.get("userId") ?? "anonymous" };
    },
    authorizeRoom: () => true,
    callTimeoutMs: 60_000,
    ...overrides,
  });
  await server.start();
  const address = server.io.httpServer.address();
  if (!address || typeof address === "string") throw new Error("Failed to resolve the server port.");
  const harness: Harness = {
    server,
    port: address.port,
    clients: [],
    close: async () => {
      for (const client of harness.clients) client.disconnect();
      await server.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

function connect(harness: Harness, userId: string, extraHeaders?: Record<string, string>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${harness.port}`, {
      query: { userId },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders,
    });
    harness.clients.push(socket);
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", (error) => reject(error));
  });
}

function connectExpectingError(
  harness: Harness,
  userId: string,
  extraHeaders?: Record<string, string>,
): Promise<Error> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://localhost:${harness.port}`, {
      query: { userId },
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
      extraHeaders,
    });
    harness.clients.push(socket);
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Expected a connect_error but the client connected."));
    }, 3000);
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      socket.disconnect();
      resolve(error);
    });
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error("Expected a connect_error but the client connected."));
    });
  });
}

function emit<T>(socket: Socket, event: string, payload: unknown): Promise<Result<T>> {
  return new Promise((resolve) => socket.emit(event, payload, (result: Result<T>) => resolve(result)));
}
async function handshake(socket: Socket): Promise<void> {
  const result = await emit<{ version: string }>(socket, "protocol:handshake", PROTOCOL_VERSION);
  expect(result.ok).toBe(true);
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const handler = (payload: T): void => {
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timed out waiting for "${event}".`));
    }, timeoutMs);
    socket.on(event, handler);
  });
}

afterEach(async () => {
  const pending = [...harnesses];
  harnesses.length = 0;
  await Promise.all(pending.map((harness) => harness.close()));
});

describe("server protocol", () => {
  test("rejects a mismatched protocol version", async () => {
    const harness = await startServer();
    const socket = await connect(harness, "alice");
    const result = await emit<{ version: string }>(socket, "protocol:handshake", "0.1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROTOCOL_MISMATCH");
    socket.disconnect();
  });

  test("rejects actions before the protocol handshake", async () => {
    const harness = await startServer();
    const socket = await connect(harness, "alice");
    const result = await emit(socket, "room:join", { roomId: "lobby" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("PROTOCOL_MISMATCH");
    socket.disconnect();
  });
});

describe("server room authorization", () => {
  test("denies joining a room the user is not authorized for", async () => {
    const harness = await startServer({
      authorizeRoom: ({ roomId }) => roomId === "allowed",
    });
    const socket = await connect(harness, "alice");
    await handshake(socket);

    const denied = await emit(socket, "room:join", { roomId: "forbidden" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("UNAUTHORIZED");

    const allowed = await emit(socket, "room:join", { roomId: "allowed" });
    expect(allowed.ok).toBe(true);
    socket.disconnect();
  });
});

describe("server presence", () => {
  test("tracks presence and broadcasts online/offline within a room", async () => {
    const harness = await startServer();
    const alice = await connect(harness, "alice");
    const bob = await connect(harness, "bob");
    await handshake(alice);
    await handshake(bob);

    // Alice joins first; the server announces user:online to everyone including the joiner.
    await emit(alice, "room:join", { roomId: "lobby" });
    const aliceSeesBob = waitFor<{ roomId: string; userId: string }>(alice, "user:online");
    const bobPresence = waitFor<{ roomId: string; userIds: string[] }>(bob, "presence:state");
    await emit(bob, "room:join", { roomId: "lobby" });

    expect((await aliceSeesBob).userId).toBe("bob");
    const presence = await bobPresence;
    expect([...presence.userIds].sort()).toEqual(["alice", "bob"]);

    const bobSeesOffline = waitFor<{ roomId: string; userId: string }>(bob, "user:offline");
    alice.disconnect();
    expect((await bobSeesOffline).userId).toBe("alice");
  });
});

describe("server messaging", () => {
  test("requires joining a room before sending a message", async () => {
    const harness = await startServer();
    const alice = await connect(harness, "alice");
    await handshake(alice);

    const result = await emit(alice, "message:send", { roomId: "lobby", content: "Hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_IN_ROOM");
    alice.disconnect();
  });

  test("delivers messages to members and delivery acks to the sender", async () => {
    const harness = await startServer();
    const alice = await connect(harness, "alice");
    const bob = await connect(harness, "bob");
    await handshake(alice);
    await handshake(bob);
    await emit(alice, "room:join", { roomId: "lobby" });
    await emit(bob, "room:join", { roomId: "lobby" });

    const bobMessage = waitFor<{ content: string; roomId: string; senderId: string }>(bob, "message");
    const aliceDelivered = waitFor<{ messageId: string; recipientId: string }>(alice, "message:delivered");
    const sent = await emit(alice, "message:send", { roomId: "lobby", content: "Hello!" });

    expect(sent.ok).toBe(true);
    const message = await bobMessage;
    expect(message.content).toBe("Hello!");
    expect(message.senderId).toBe("alice");
    const delivered = await aliceDelivered;
    expect(delivered.recipientId).toBe("bob");
    alice.disconnect();
    bob.disconnect();
  });
});

describe("server one-to-one call state machine", () => {
  test("runs a call through ringing, accept, and hangup", async () => {
    const harness = await startServer();
    const alice = await connect(harness, "alice");
    const bob = await connect(harness, "bob");
    await handshake(alice);
    await handshake(bob);
    await emit(alice, "room:join", { roomId: "lobby" });
    await emit(bob, "room:join", { roomId: "lobby" });

    const bobIncoming = waitFor<{ callId: string; roomId: string; callerId: string }>(bob, "call:incoming");
    const started = await emit<{ callId: string }>(alice, "call:start", { roomId: "lobby", mediaType: "audio" });
    expect(started.ok).toBe(true);
    const incoming = await bobIncoming;
    expect(incoming.callerId).toBe("alice");

    // call:accepted is delivered only to the caller; the recipient is confirmed by the accept ack.
    const aliceAccepted = waitFor<unknown>(alice, "call:accepted");
    const accepted = await emit(bob, "call:accept", { callId: incoming.callId });
    expect(accepted.ok).toBe(true);
    await aliceAccepted;

    const aliceEnded = waitFor<{ reason: string }>(alice, "call:ended");
    const bobEnded = waitFor<{ reason: string }>(bob, "call:ended");
    const hungUp = await emit(alice, "call:hangup", { callId: incoming.callId });
    expect(hungUp.ok).toBe(true);
    expect((await aliceEnded).reason).toBe("hangup");
    expect((await bobEnded).reason).toBe("hangup");
    alice.disconnect();
    bob.disconnect();
  });
});

describe("server origin validation", () => {
  test("rejects disallowed origins but allows allowed and headerless clients", async () => {
    const harness = await startServer({ origin: ["https://app.example.com"] });

    const evil = await connectExpectingError(harness, "alice", { Origin: "https://evil.example.com" });
    expect(evil.message).toContain("Origin not allowed");

    const headerless = await connect(harness, "alice");
    expect(headerless.connected).toBe(true);
    headerless.disconnect();

    const allowed = await connect(harness, "alice", { Origin: "https://app.example.com" });
    expect(allowed.connected).toBe(true);
    allowed.disconnect();
  });
});

describe("server rate limiting", () => {
  test("rejects events over the per-window limit with RATE_LIMITED", async () => {
    const harness = await startServer({ rateLimit: { windowMs: 1000, max: 2 } });
    const alice = await connect(harness, "alice");
    await handshake(alice);

    const joined = await emit(alice, "room:join", { roomId: "lobby" });
    expect(joined.ok).toBe(true);
    const sent = await emit(alice, "message:send", { roomId: "lobby", content: "one" });
    expect(sent.ok).toBe(true);

    const limited = await emit(alice, "message:send", { roomId: "lobby", content: "two" });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.error.code).toBe("RATE_LIMITED");
    alice.disconnect();
  });
});

describe("server buffer size", () => {
  test("applies the configured maxHttpBufferSize", async () => {
    const harness = await startServer({ maxHttpBufferSize: 4096 });
    expect(harness.server.io.engine.opts.maxHttpBufferSize).toBe(4096);
  });
});
