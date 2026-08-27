import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  PROTOCOL_VERSION,
  errorResult,
  type AuthenticatedUser,
  type ClientToServerEvents,
  type JoinRoomInput,
  type MessageDeliveredEvent,
  type Result,
  type RoomAction,
  type SendMessageInput,
  type ServerToClientEvents
} from "@realtime/core";

type SocketData = { user: AuthenticatedUser; protocolAccepted: boolean };
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

export type RealtimeServerOptions = {
  port?: number;
  cors?: { origin?: string | string[]; credentials?: boolean };
  authenticate: (request: IncomingMessage) => Promise<AuthenticatedUser> | AuthenticatedUser;
  authorizeRoom?: (context: { user: AuthenticatedUser; roomId: string; action: RoomAction }) => Promise<boolean> | boolean;
};

const invalid = (message: string) => errorResult("INVALID_PAYLOAD", message);
const validRoom = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

export class RealtimeServer {
  readonly io: Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
  private httpServer?: HttpServer;

  constructor(private readonly options: RealtimeServerOptions) {
    this.io = new Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>({ cors: options.cors });
    this.io.use(async (socket, next) => {
      try {
        const user = await options.authenticate(socket.request);
        if (!user?.userId) return next(new Error("Authentication must return a userId."));
        socket.data.user = user;
        socket.data.protocolAccepted = false;
        next();
      } catch {
        next(new Error("Authentication failed."));
      }
    });
    this.io.on("connection", (socket) => this.registerSocket(socket));
  }

  attach(server: HttpServer): this {
    this.io.attach(server);
    return this;
  }

  async start(): Promise<void> {
    if (this.httpServer) throw new Error("Realtime server is already started.");
    this.httpServer = createServer();
    this.attach(this.httpServer);
    await new Promise<void>((resolve) => this.httpServer!.listen(this.options.port ?? 3001, resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.io.close(() => resolve()));
    this.httpServer = undefined;
  }

  private registerSocket(socket: TypedSocket): void {
    socket.on("disconnecting", () => { void this.announceDisconnect(socket); });

    socket.on("protocol:handshake", (version, ack) => {
      if (version !== PROTOCOL_VERSION) return ack(errorResult("PROTOCOL_MISMATCH", `Expected protocol ${PROTOCOL_VERSION}.`));
      socket.data.protocolAccepted = true;
      ack({ ok: true, data: { version: PROTOCOL_VERSION } });
    });

    socket.on("room:join", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validJoin(input, ack)) return;
      if (!(await this.allowed(socket, input.roomId, "join", ack))) return;
      const userWasPresent = await this.userIsPresent(input.roomId, socket.data.user.userId);
      await socket.join(input.roomId);
      const joined = { roomId: input.roomId, userId: socket.data.user.userId };
      socket.to(input.roomId).emit("room:joined", joined);
      if (!userWasPresent) this.io.to(input.roomId).emit("user:online", joined);
      socket.emit("presence:state", { roomId: input.roomId, userIds: await this.userIdsInRoom(input.roomId) });
      ack({ ok: true, data: { roomId: input.roomId } });
    });

    socket.on("room:leave", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validJoin(input, ack)) return;
      await socket.leave(input.roomId);
      socket.to(input.roomId).emit("room:left", { roomId: input.roomId, userId: socket.data.user.userId });
      if (!(await this.userIsPresent(input.roomId, socket.data.user.userId))) {
        this.io.to(input.roomId).emit("user:offline", { roomId: input.roomId, userId: socket.data.user.userId });
      }
      ack({ ok: true, data: { roomId: input.roomId } });
    });

    socket.on("message:send", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validMessage(input, ack)) return;
      if (!socket.rooms.has(input.roomId)) return ack(errorResult("NOT_IN_ROOM", "Join the room before sending a message."));
      if (!(await this.allowed(socket, input.roomId, "send-message", ack))) return;
      const message = { id: randomUUID(), roomId: input.roomId, senderId: socket.data.user.userId, content: input.content.trim(), clientMessageId: input.clientMessageId, sentAt: new Date().toISOString() };
      this.io.to(input.roomId).emit("message", message);
      const deliveredAt = new Date().toISOString();
      for (const recipientId of await this.userIdsInRoom(input.roomId, socket.id)) {
        if (recipientId === socket.data.user.userId) continue;
        const delivered: MessageDeliveredEvent = { messageId: message.id, roomId: input.roomId, recipientId, deliveredAt };
        socket.emit("message:delivered", delivered);
      }
      ack({ ok: true, data: message });
    });

    socket.on("typing:set", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validTyping(input, ack)) return;
      if (!socket.rooms.has(input.roomId)) return ack(errorResult("NOT_IN_ROOM", "Join the room before setting typing state."));
      if (!(await this.allowed(socket, input.roomId, "typing", ack))) return;
      const typing = { roomId: input.roomId, userId: socket.data.user.userId };
      for (const recipient of await this.io.in(input.roomId).fetchSockets()) {
        if (recipient.data.user?.userId === socket.data.user.userId) continue;
        if (input.isTyping) recipient.emit("typing:start", typing);
        else recipient.emit("typing:stop", typing);
      }
      ack({ ok: true, data: { roomId: input.roomId, isTyping: input.isTyping } });
    });
  }

  private ready<T>(socket: TypedSocket, ack: (result: Result<T>) => void): boolean {
    if (socket.data.protocolAccepted) return true;
    ack(errorResult("PROTOCOL_MISMATCH", "Complete the protocol handshake first."));
    return false;
  }

  private validJoin<T>(input: JoinRoomInput, ack: (result: Result<T>) => void): boolean {
    if (validRoom(input?.roomId)) return true;
    ack(invalid("roomId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validMessage<T>(input: SendMessageInput, ack: (result: Result<T>) => void): boolean {
    if (!validRoom(input?.roomId)) { ack(invalid("roomId must be valid.")); return false; }
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 10_000) { ack(invalid("content must be a non-empty string up to 10,000 characters.")); return false; }
    return true;
  }

  private validTyping<T>(input: { roomId: unknown; isTyping: unknown }, ack: (result: Result<T>) => void): input is { roomId: string; isTyping: boolean } {
    if (!validRoom(input?.roomId) || typeof input.isTyping !== "boolean") {
      ack(invalid("roomId must be valid and isTyping must be a boolean."));
      return false;
    }
    return true;
  }

  private async announceDisconnect(socket: TypedSocket): Promise<void> {
    const rooms = [...socket.rooms].filter((roomId) => roomId !== socket.id);
    for (const roomId of rooms) {
      const userId = socket.data.user.userId;
      const stillPresent = await this.userIsPresent(roomId, userId, socket.id);
      if (!stillPresent) socket.to(roomId).emit("user:offline", { roomId, userId });
    }
  }

  private async userIdsInRoom(roomId: string, exceptSocketId?: string): Promise<string[]> {
    const sockets = await this.io.in(roomId).fetchSockets();
    return [...new Set(sockets.filter((socket) => socket.id !== exceptSocketId).map((socket) => socket.data.user?.userId).filter((userId): userId is string => Boolean(userId)))];
  }

  private async userIsPresent(roomId: string, userId: string, exceptSocketId?: string): Promise<boolean> {
    return (await this.userIdsInRoom(roomId, exceptSocketId)).includes(userId);
  }

  private async allowed<T>(socket: TypedSocket, roomId: string, action: RoomAction, ack: (result: Result<T>) => void): Promise<boolean> {
    if (!this.options.authorizeRoom || await this.options.authorizeRoom({ user: socket.data.user, roomId, action })) return true;
    ack(errorResult("UNAUTHORIZED", "You are not authorized for this room action."));
    return false;
  }
}

export const createRealtimeServer = (options: RealtimeServerOptions): RealtimeServer => new RealtimeServer(options);
