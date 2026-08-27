import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Server, type Socket } from "socket.io";
import {
  PROTOCOL_VERSION,
  errorResult,
  type AuthenticatedUser,
  type CallEndReason,
  type CallMediaType,
  type CallResponseInput,
  type CallStartInput,
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
type ActiveCall = {
  id: string;
  roomId: string;
  callerSocketId: string;
  callerId: string;
  recipientSocketId: string;
  recipientId: string;
  mediaType: CallMediaType;
  state: "ringing" | "active";
  timeout: ReturnType<typeof setTimeout>;
};

export type RealtimeServerOptions = {
  port?: number;
  cors?: { origin?: string | string[]; credentials?: boolean };
  authenticate: (request: IncomingMessage) => Promise<AuthenticatedUser> | AuthenticatedUser;
  authorizeRoom?: (context: { user: AuthenticatedUser; roomId: string; action: RoomAction }) => Promise<boolean> | boolean;
  /** Time an unanswered call rings before it ends. Defaults to 30 seconds. */
  callTimeoutMs?: number;
};

const invalid = (message: string) => errorResult("INVALID_PAYLOAD", message);
const validRoom = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 200;

export class RealtimeServer {
  readonly io: Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
  private httpServer?: HttpServer;
  private readonly calls = new Map<string, ActiveCall>();

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
    for (const call of this.calls.values()) clearTimeout(call.timeout);
    this.calls.clear();
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
      for (const call of [...this.calls.values()]) {
        if (call.roomId === input.roomId && (call.callerSocketId === socket.id || call.recipientSocketId === socket.id)) {
          this.finishCall(call, "room-left", socket.data.user.userId, false);
        }
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

    socket.on("call:start", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCallStart(input, ack)) return;
      if (!socket.rooms.has(input.roomId)) return ack(errorResult("NOT_IN_ROOM", "Join the room before starting a call."));
      if (!(await this.allowed(socket, input.roomId, "call", ack))) return;
      const recipients = (await this.io.in(input.roomId).fetchSockets()).filter((candidate) => candidate.id !== socket.id && candidate.data.user.userId !== socket.data.user.userId);
      const recipientIds = new Set(recipients.map((candidate) => candidate.data.user.userId));
      if (recipientIds.size !== 1) return ack(errorResult("CALL_UNAVAILABLE", "A one-to-one call requires exactly one other user in the room."));
      const recipient = recipients[0];
      const callId = randomUUID();
      const call: ActiveCall = {
        id: callId,
        roomId: input.roomId,
        callerSocketId: socket.id,
        callerId: socket.data.user.userId,
        recipientSocketId: recipient.id,
        recipientId: recipient.data.user.userId,
        mediaType: input.mediaType ?? "audio",
        state: "ringing",
        timeout: setTimeout(() => this.endCall(callId, "timeout"), this.options.callTimeoutMs ?? 30_000)
      };
      this.calls.set(callId, call);
      recipient.emit("call:incoming", { callId, roomId: call.roomId, callerId: call.callerId, mediaType: call.mediaType });
      ack({ ok: true, data: { callId, roomId: call.roomId, recipientId: call.recipientId } });
    });

    socket.on("call:accept", async (input, ack) => {
      const call = await this.callFor(socket, input, ack, "recipient", "ringing");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      clearTimeout(call.timeout);
      call.state = "active";
      this.io.to(call.callerSocketId).emit("call:accepted", { callId: call.id, roomId: call.roomId, recipientId: call.recipientId, mediaType: call.mediaType });
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("call:reject", async (input, ack) => {
      const call = await this.callFor(socket, input, ack, "recipient", "ringing");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      this.io.to(call.callerSocketId).emit("call:rejected", { callId: call.id, roomId: call.roomId, recipientId: call.recipientId });
      this.finishCall(call, "rejected", socket.data.user.userId, false);
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("call:hangup", async (input, ack) => {
      const call = await this.callFor(socket, input, ack, "participant");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      this.finishCall(call, "hangup", socket.data.user.userId);
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("webrtc:offer", async (input, ack) => this.relayDescription(socket, input, ack, "webrtc:offer"));
    socket.on("webrtc:answer", async (input, ack) => this.relayDescription(socket, input, ack, "webrtc:answer"));
    socket.on("webrtc:ice-candidate", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCandidate(input, ack)) return;
      const call = await this.callFor(socket, input, ack, "participant", "active");
      if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
      const targetSocketId = socket.id === call.callerSocketId ? call.recipientSocketId : call.callerSocketId;
      this.io.to(targetSocketId).emit("webrtc:ice-candidate", { callId: call.id, roomId: call.roomId, senderId: socket.data.user.userId, candidate: input.candidate });
      ack({ ok: true, data: { callId: call.id } });
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

  private validCallStart<T>(input: CallStartInput, ack: (result: Result<T>) => void): boolean {
    if (!this.validJoin(input, ack)) return false;
    if (input.mediaType !== undefined && input.mediaType !== "audio" && input.mediaType !== "video") {
      ack(invalid("mediaType must be audio or video."));
      return false;
    }
    return true;
  }

  private validCallId<T, I extends { callId?: unknown }>(input: I, ack: (result: Result<T>) => void): input is I & CallResponseInput {
    if (typeof input?.callId === "string" && input.callId.length > 0 && input.callId.length <= 200) return true;
    ack(invalid("callId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validDescription<T>(input: { callId?: unknown; description?: { type?: unknown; sdp?: unknown } }, ack: (result: Result<T>) => void): boolean {
    if (!this.validCallId(input, ack)) return false;
    if ((input.description?.type === "offer" || input.description?.type === "answer") && typeof input.description.sdp === "string" && input.description.sdp.length > 0 && input.description.sdp.length <= 200_000) return true;
    ack(invalid("description must contain an offer or answer with a non-empty SDP string."));
    return false;
  }

  private validCandidate<T>(input: { callId?: unknown; candidate?: { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown; usernameFragment?: unknown } }, ack: (result: Result<T>) => void): boolean {
    if (!this.validCallId(input, ack)) return false;
    const candidate = input.candidate;
    if (typeof candidate?.candidate !== "string" || candidate.candidate.length > 10_000) { ack(invalid("candidate must contain a valid candidate string.")); return false; }
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null && typeof candidate.sdpMid !== "string") { ack(invalid("candidate.sdpMid must be a string or null.")); return false; }
    if (candidate.sdpMLineIndex !== undefined && candidate.sdpMLineIndex !== null && (typeof candidate.sdpMLineIndex !== "number" || !Number.isInteger(candidate.sdpMLineIndex) || candidate.sdpMLineIndex < 0)) { ack(invalid("candidate.sdpMLineIndex must be a non-negative integer or null.")); return false; }
    if (candidate.usernameFragment !== undefined && candidate.usernameFragment !== null && typeof candidate.usernameFragment !== "string") { ack(invalid("candidate.usernameFragment must be a string or null.")); return false; }
    return true;
  }

  private async announceDisconnect(socket: TypedSocket): Promise<void> {
    const rooms = [...socket.rooms].filter((roomId) => roomId !== socket.id);
    for (const roomId of rooms) {
      const userId = socket.data.user.userId;
      const stillPresent = await this.userIsPresent(roomId, userId, socket.id);
      if (!stillPresent) socket.to(roomId).emit("user:offline", { roomId, userId });
    }
    for (const call of [...this.calls.values()]) {
      if (call.callerSocketId === socket.id || call.recipientSocketId === socket.id) this.finishCall(call, "disconnected", socket.data.user.userId, false);
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

  private async callFor<T>(socket: TypedSocket, input: { callId?: unknown }, ack: (result: Result<T>) => void, role: "caller" | "recipient" | "participant", state?: ActiveCall["state"]): Promise<ActiveCall | undefined> {
    if (!this.ready(socket, ack) || !this.validCallId(input, ack)) return undefined;
    const call = this.calls.get(input.callId);
    if (!call) { ack(errorResult("CALL_NOT_FOUND", "The call no longer exists.")); return undefined; }
    const isCaller = call.callerSocketId === socket.id;
    const isRecipient = call.recipientSocketId === socket.id;
    if ((role === "caller" && !isCaller) || (role === "recipient" && !isRecipient) || (role === "participant" && !isCaller && !isRecipient)) {
      ack(errorResult("UNAUTHORIZED", "You are not a participant in this call."));
      return undefined;
    }
    if (state && call.state !== state) { ack(errorResult("CALL_INVALID_STATE", `This action is not available while the call is ${call.state}.`)); return undefined; }
    return call;
  }

  private async relayDescription<T>(socket: TypedSocket, input: { callId?: unknown; description?: { type?: unknown; sdp?: unknown } }, ack: (result: Result<T>) => void, event: "webrtc:offer" | "webrtc:answer"): Promise<void> {
    if (!this.ready(socket, ack) || !this.validDescription(input, ack)) return;
    const call = await this.callFor(socket, input, ack, "participant", "active");
    if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
    const targetSocketId = socket.id === call.callerSocketId ? call.recipientSocketId : call.callerSocketId;
    this.io.to(targetSocketId).emit(event, { callId: call.id, roomId: call.roomId, senderId: socket.data.user.userId, description: input.description as { type: "offer" | "answer"; sdp: string } });
    ack({ ok: true, data: { callId: call.id } } as Result<T>);
  }

  private endCall(callId: string, reason: CallEndReason): void {
    const call = this.calls.get(callId);
    if (call) this.finishCall(call, reason);
  }

  private finishCall(call: ActiveCall, reason: CallEndReason, endedById?: string, notifyBoth = true): void {
    if (!this.calls.delete(call.id)) return;
    clearTimeout(call.timeout);
    const event = { callId: call.id, roomId: call.roomId, endedById, reason };
    if (notifyBoth) {
      this.io.to(call.callerSocketId).emit("call:ended", event);
      this.io.to(call.recipientSocketId).emit("call:ended", event);
    } else {
      const remainingSocketId = endedById === call.callerId ? call.recipientSocketId : call.callerSocketId;
      this.io.to(remainingSocketId).emit("call:ended", event);
    }
  }
}

export const createRealtimeServer = (options: RealtimeServerOptions): RealtimeServer => new RealtimeServer(options);
