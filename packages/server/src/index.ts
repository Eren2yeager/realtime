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
  type GroupCallIncomingEvent,
  type GroupCallJoinResult,
  type GroupCallParticipantEvent,
  type GroupCallResult,
  type JoinRoomInput,
  type MessageDeliveredEvent,
  type Result,
  type RoomAction,
  type SendMessageInput,
  type ServerToClientEvents,
  type SfuDtlsParameters,
  type SfuIceCandidate,
  type SfuIceParameters,
  type SfuMediaMode,
  type SfuProducerAddedEvent,
  type SfuProducerRemovedEvent,
  type SfuRtpCapabilities,
  type SfuRtpParameters,
} from "@realtimesdk/core";

type SocketData = { user: AuthenticatedUser; protocolAccepted: boolean; rate?: { windowStart: number; count: number } };
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

type ActiveGroupCall = {
  id: string;
  roomId: string;
  callerSocketId: string;
  callerId: string;
  mediaType: CallMediaType;
  mediaMode: SfuMediaMode;
  state: "ringing" | "active";
  /** userId -> socketId of participants who have joined (the caller is a participant from the start). */
  participants: Map<string, string>;
  /** userId -> socketId of members still being rung. */
  invitees: Map<string, string>;
  /** Per-participant SFU media state (userId -> transports and producers), populated for SFU-mode calls. */
  sfuMedia?: Map<string, SfuParticipantMedia>;
  timeout: ReturnType<typeof setTimeout>;
};

export type SfuTransportDirection = "send" | "recv";
export type SfuTransportParams = {
  transportId: string;
  iceParameters: SfuIceParameters;
  iceCandidates: SfuIceCandidate[];
  dtlsParameters: SfuDtlsParameters;
};

/** The SFU room surface the coordinator uses. Satisfied structurally by @realtimesdk/sfu's SfuRoom. */
export type SfuRoomHandle = {
  readonly roomId: string;
  readonly rtpCapabilities: SfuRtpCapabilities;
  createTransport(input: {
    direction: SfuTransportDirection;
    appData?: Record<string, unknown>;
  }): Promise<SfuTransportParams>;
  connectTransport(transportId: string, dtlsParameters: SfuDtlsParameters): Promise<void>;
  produce(input: {
    transportId: string;
    kind: "audio" | "video";
    rtpParameters: SfuRtpParameters;
    appData?: Record<string, unknown>;
  }): Promise<{ id: string; kind: "audio" | "video"; appData?: Record<string, unknown> }>;
  consume(input: { transportId: string; producerId: string; rtpCapabilities: SfuRtpCapabilities }): Promise<{
    id: string;
    producerId: string;
    kind: "audio" | "video";
    rtpParameters: SfuRtpParameters;
    paused: boolean;
  }>;
  resumeConsumer(consumerId: string): Promise<void>;
  closeProducer(producerId: string): void;
  closeConsumer(consumerId: string): void;
  closeTransport(transportId: string): Promise<void>;
  close(): void;
};

/** The SFU node surface the coordinator uses. Satisfied structurally by @realtimesdk/sfu's SfuNode. */
export type SfuNodeHandle = {
  start(): Promise<void>;
  room(roomId: string): SfuRoomHandle | undefined;
  createRoom(roomId: string): Promise<SfuRoomHandle>;
  closeRoom(roomId: string): boolean;
  close(): Promise<void>;
};

type SfuParticipantMedia = { transports: Set<string>; producers: Map<string, SfuProducerInfo> };
type SfuProducerInfo = { kind: "audio" | "video"; appData?: Record<string, unknown> };

export type RealtimeServerOptions = {
  port?: number;
  cors?: { origin?: string | string[]; credentials?: boolean };
  authenticate: (request: IncomingMessage) => Promise<AuthenticatedUser> | AuthenticatedUser;
  authorizeRoom?: (context: {
    user: AuthenticatedUser;
    roomId: string;
    action: RoomAction;
  }) => Promise<boolean> | boolean;
  /** Time an unanswered call rings before it ends. Defaults to 30 seconds. */
  callTimeoutMs?: number;
  /** Optional SFU media-routing node. When set, group calls route media through it where useSfuForRoom allows. */
  sfu?: SfuNodeHandle;
  /** Decides whether a room's group calls use the SFU. Defaults to true whenever an SFU is configured. */
  useSfuForRoom?: (roomId: string) => boolean;
  /** Maximum size in bytes of an incoming packet. Defaults to 1,000,000 (1 MB). */
  maxHttpBufferSize?: number;
  /** Allowed browser origins for the WebSocket handshake. When set, requests with an
   * Origin header are validated against this allowlist; requests without an Origin header
   * (for example non-browser clients) are allowed unless a function rejects them. */
  origin?: string | string[] | RegExp | ((origin: string | undefined) => boolean);
  /** Per-connection rate limiting for inbound events. Disabled unless provided. */
  rateLimit?: {
    /** Length of the window in milliseconds. Defaults to 1000. */
    windowMs?: number;
    /** Maximum events allowed per window before the connection is limited. Defaults to 100. */
    max?: number;
  };
};

const invalid = (message: string) => errorResult("INVALID_PAYLOAD", message);
const validRoom = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 200;
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : "Unknown SFU error.");

export class RealtimeServer {
  readonly io: Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
  private httpServer?: HttpServer;
  private readonly calls = new Map<string, ActiveCall>();
  private readonly groupCalls = new Map<string, ActiveGroupCall>();
  /** Number of active SFU-mode group calls per realtime room, so SFU Routers are ref-counted. */
  private readonly sfuRooms = new Map<string, number>();

  constructor(private readonly options: RealtimeServerOptions) {
    this.io = new Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>({
      cors: options.cors,
      maxHttpBufferSize: options.maxHttpBufferSize ?? 1_000_000,
    });
    this.io.use((socket, next) => {
      if (!this.allowsOrigin(socket.request.headers.origin)) return next(new Error("Origin not allowed."));
      next();
    });
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
    for (const call of this.groupCalls.values()) clearTimeout(call.timeout);
    this.groupCalls.clear();
    // Forcibly close every client connection at the engine.io layer first; without
    // this the HTTP server can hold polling sockets open indefinitely while
    // waiting for graceful disconnects.
    this.io.disconnectSockets(true);
    // Close engine.io's internal state immediately so it does not block shutdown.
    this.io.engine.close();
    if (this.httpServer && this.httpServer.listening) {
      this.httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
    }
    this.httpServer = undefined;
  }

  private registerSocket(socket: TypedSocket): void {
    socket.on("disconnecting", () => {
      void this.announceDisconnect(socket);
    });

    socket.on("protocol:handshake", (version, ack) => {
      if (version !== PROTOCOL_VERSION)
        return ack(errorResult("PROTOCOL_MISMATCH", `Expected protocol ${PROTOCOL_VERSION}.`));
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
        if (
          call.roomId === input.roomId &&
          (call.callerSocketId === socket.id || call.recipientSocketId === socket.id)
        ) {
          this.finishCall(call, "room-left", socket.data.user.userId, false);
        }
      }
      for (const call of [...this.groupCalls.values()]) {
        if (
          call.roomId === input.roomId &&
          (call.participants.has(socket.data.user.userId) || call.invitees.has(socket.data.user.userId))
        ) {
          this.leaveGroupCall(call, socket.data.user.userId, "room-left");
        }
      }
      ack({ ok: true, data: { roomId: input.roomId } });
    });

    socket.on("message:send", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validMessage(input, ack)) return;
      if (!socket.rooms.has(input.roomId))
        return ack(errorResult("NOT_IN_ROOM", "Join the room before sending a message."));
      if (!(await this.allowed(socket, input.roomId, "send-message", ack))) return;
      const message = {
        id: randomUUID(),
        roomId: input.roomId,
        senderId: socket.data.user.userId,
        content: input.content.trim(),
        clientMessageId: input.clientMessageId,
        sentAt: new Date().toISOString(),
      };
      this.io.to(input.roomId).emit("message", message);
      const deliveredAt = new Date().toISOString();
      for (const recipientId of await this.userIdsInRoom(input.roomId, socket.id)) {
        if (recipientId === socket.data.user.userId) continue;
        const delivered: MessageDeliveredEvent = {
          messageId: message.id,
          roomId: input.roomId,
          recipientId,
          deliveredAt,
        };
        socket.emit("message:delivered", delivered);
      }
      ack({ ok: true, data: message });
    });

    socket.on("typing:set", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validTyping(input, ack)) return;
      if (!socket.rooms.has(input.roomId))
        return ack(errorResult("NOT_IN_ROOM", "Join the room before setting typing state."));
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
      if (!socket.rooms.has(input.roomId))
        return ack(errorResult("NOT_IN_ROOM", "Join the room before starting a call."));
      if (!(await this.allowed(socket, input.roomId, "call", ack))) return;
      const recipients = (await this.io.in(input.roomId).fetchSockets()).filter(
        (candidate) => candidate.id !== socket.id && candidate.data.user.userId !== socket.data.user.userId,
      );
      const recipientIds = new Set(recipients.map((candidate) => candidate.data.user.userId));
      if (recipientIds.size !== 1)
        return ack(errorResult("CALL_UNAVAILABLE", "A one-to-one call requires exactly one other user in the room."));
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
        timeout: setTimeout(() => this.endCall(callId, "timeout"), this.options.callTimeoutMs ?? 30_000),
      };
      this.calls.set(callId, call);
      recipient.emit("call:incoming", {
        callId,
        roomId: call.roomId,
        callerId: call.callerId,
        mediaType: call.mediaType,
      });
      ack({ ok: true, data: { callId, roomId: call.roomId, recipientId: call.recipientId } });
    });

    socket.on("call:accept", async (input, ack) => {
      const call = await this.callFor(socket, input, ack, "recipient", "ringing");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      clearTimeout(call.timeout);
      call.state = "active";
      this.io.to(call.callerSocketId).emit("call:accepted", {
        callId: call.id,
        roomId: call.roomId,
        recipientId: call.recipientId,
        mediaType: call.mediaType,
      });
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("call:reject", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCallId(input, ack)) return;
      const groupCall = this.groupCalls.get(input.callId);
      if (groupCall) {
        if (groupCall.invitees.has(socket.data.user.userId)) {
          this.io.to(groupCall.callerSocketId).emit("call:rejected", {
            callId: groupCall.id,
            roomId: groupCall.roomId,
            recipientId: socket.data.user.userId,
          });
          groupCall.invitees.delete(socket.data.user.userId);
          if (groupCall.participants.size === 0 && groupCall.invitees.size === 0)
            this.finishGroupCall(groupCall, "rejected", socket.data.user.userId);
        }
        return ack({ ok: true, data: { callId: groupCall.id } });
      }
      const call = await this.callFor(socket, input, ack, "recipient", "ringing");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      this.io
        .to(call.callerSocketId)
        .emit("call:rejected", { callId: call.id, roomId: call.roomId, recipientId: call.recipientId });
      this.finishCall(call, "rejected", socket.data.user.userId, false);
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("call:hangup", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCallId(input, ack)) return;
      const groupCall = this.groupCalls.get(input.callId);
      if (groupCall) {
        if (!(await this.allowed(socket, groupCall.roomId, "call", ack))) return;
        if (groupCall.participants.has(socket.data.user.userId) || groupCall.invitees.has(socket.data.user.userId)) {
          this.leaveGroupCall(groupCall, socket.data.user.userId, "hangup");
        }
        return ack({ ok: true, data: { callId: groupCall.id } });
      }
      const call = await this.callFor(socket, input, ack, "participant");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      this.finishCall(call, "hangup", socket.data.user.userId);
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("call:start-group", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCallStart(input, ack)) return;
      if (!socket.rooms.has(input.roomId))
        return ack(errorResult("NOT_IN_ROOM", "Join the room before starting a group call."));
      if (!(await this.allowed(socket, input.roomId, "call", ack))) return;
      const inviteeSockets = (await this.io.in(input.roomId).fetchSockets()).filter(
        (candidate) =>
          candidate.id !== socket.id &&
          candidate.data.user?.userId &&
          candidate.data.user.userId !== socket.data.user.userId,
      );
      const inviteeMap = new Map<string, string>();
      const participantIds = [socket.data.user.userId];
      for (const invitee of inviteeSockets) {
        if (!inviteeMap.has(invitee.data.user.userId)) {
          inviteeMap.set(invitee.data.user.userId, invitee.id);
          participantIds.push(invitee.data.user.userId);
        }
      }
      const mediaMode = this.mediaModeFor(input.roomId);
      if (mediaMode === "sfu") {
        try {
          await this.ensureSfuRoom(input.roomId);
        } catch (error) {
          return ack(errorResult("SFU_UNAVAILABLE", errorMessage(error)));
        }
      }
      const callId = randomUUID();
      const call: ActiveGroupCall = {
        id: callId,
        roomId: input.roomId,
        callerSocketId: socket.id,
        callerId: socket.data.user.userId,
        mediaType: input.mediaType ?? "audio",
        mediaMode,
        state: "ringing",
        participants: new Map([[socket.data.user.userId, socket.id]]),
        invitees: inviteeMap,
        timeout: setTimeout(() => this.endGroupCall(callId, "timeout"), this.options.callTimeoutMs ?? 30_000),
      };
      this.groupCalls.set(callId, call);
      const incoming: GroupCallIncomingEvent = {
        callId,
        roomId: call.roomId,
        callerId: call.callerId,
        mediaType: call.mediaType,
        participantIds,
        selfId: "",
        mediaMode,
      };
      for (const [userId, socketId] of inviteeMap) {
        const inviteeSocket = this.io.sockets.sockets.get(socketId);
        inviteeSocket?.emit("group:call:incoming", { ...incoming, selfId: userId });
      }
      ack({
        ok: true,
        data: {
          callId,
          roomId: call.roomId,
          participantIds,
          selfId: socket.data.user.userId,
          mediaMode,
        } as GroupCallResult,
      });
    });

    socket.on("call:join", async (input, ack) => {
      const call = await this.groupCallFor(socket, input, ack, "invitee");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      call.invitees.delete(socket.data.user.userId);
      call.participants.set(socket.data.user.userId, socket.id);
      if (call.state === "ringing") {
        call.state = "active";
        clearTimeout(call.timeout);
      }
      const participantIds = [...call.participants.keys()];
      const participantJoined: GroupCallParticipantEvent = {
        callId: call.id,
        roomId: call.roomId,
        participantId: socket.data.user.userId,
        participantIds,
        selfId: "",
      };
      for (const [participantId, socketId] of call.participants) {
        if (participantId === socket.data.user.userId) continue;
        this.io.sockets.sockets
          .get(socketId)
          ?.emit("group:call:participant-joined", { ...participantJoined, selfId: participantId });
      }
      if (call.mediaMode === "sfu") {
        for (const [participantId, media] of call.sfuMedia ?? []) {
          if (participantId === socket.data.user.userId) continue;
          for (const [producerId, info] of media.producers) {
            socket.emit("sfu:producer-added", {
              callId: call.id,
              roomId: call.roomId,
              producerId,
              peerId: participantId,
              kind: info.kind,
              appData: info.appData,
            });
          }
        }
      }
      ack({
        ok: true,
        data: {
          callId: call.id,
          participantIds,
          selfId: socket.data.user.userId,
          mediaMode: call.mediaMode,
        } as GroupCallJoinResult,
      });
    });

    socket.on("call:leave", async (input, ack) => {
      const call = await this.groupCallFor(socket, input, ack, "participant");
      if (!call) return;
      if (!(await this.allowed(socket, call.roomId, "call", ack))) return;
      this.leaveGroupCall(call, socket.data.user.userId, "hangup");
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("group:webrtc:offer", async (input, ack) =>
      this.relayGroupDescription(socket, input, ack, "group:webrtc:offer"),
    );
    socket.on("group:webrtc:answer", async (input, ack) =>
      this.relayGroupDescription(socket, input, ack, "group:webrtc:answer"),
    );
    socket.on("group:webrtc:ice-candidate", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validGroupCandidate(input, ack)) return;
      const call = await this.groupCallFor(socket, input, ack, "participant", "active");
      if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
      const targetSocketId = call.participants.get(input.targetId);
      if (!targetSocketId)
        return ack(errorResult("UNAUTHORIZED", "The signaling target is not a participant in this call."));
      this.io.to(targetSocketId).emit("group:webrtc:ice-candidate", {
        callId: call.id,
        roomId: call.roomId,
        senderId: socket.data.user.userId,
        targetId: input.targetId,
        candidate: input.candidate,
      });
      ack({ ok: true, data: { callId: call.id } });
    });

    socket.on("sfu:rtp-capabilities", async (input, ack) => {
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      ack({ ok: true, data: { rtpCapabilities: resolved.room.rtpCapabilities } });
    });

    socket.on("sfu:create-transport", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCallId(input, ack) || !this.validSfuDirection(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        const transport = await resolved.room.createTransport({ direction: input.direction, appData: input.appData });
        this.participantSfu(resolved.call, socket.data.user.userId).transports.add(transport.transportId);
        ack({ ok: true, data: transport });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:connect-transport", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuConnect(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        await resolved.room.connectTransport(input.transportId, input.dtlsParameters);
        ack({ ok: true, data: { transportId: input.transportId } });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:produce", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuProduce(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      const { call, room } = resolved;
      try {
        const producer = await room.produce({
          transportId: input.transportId,
          kind: input.kind,
          rtpParameters: input.rtpParameters,
          appData: input.appData,
        });
        this.participantSfu(call, socket.data.user.userId).producers.set(producer.id, {
          kind: producer.kind,
          appData: producer.appData,
        });
        const event: SfuProducerAddedEvent = {
          callId: call.id,
          roomId: call.roomId,
          producerId: producer.id,
          peerId: socket.data.user.userId,
          kind: producer.kind,
          appData: producer.appData,
        };
        for (const [participantId, socketId] of call.participants) {
          if (participantId === socket.data.user.userId) continue;
          this.io.sockets.sockets.get(socketId)?.emit("sfu:producer-added", event);
        }
        ack({ ok: true, data: { producerId: producer.id, kind: producer.kind } });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:consume", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuConsume(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        const consumer = await resolved.room.consume({
          transportId: input.transportId,
          producerId: input.producerId,
          rtpCapabilities: input.rtpCapabilities,
        });
        ack({
          ok: true,
          data: {
            consumerId: consumer.id,
            producerId: consumer.producerId,
            kind: consumer.kind,
            rtpParameters: consumer.rtpParameters,
            paused: consumer.paused,
          },
        });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:resume-consumer", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuConsumer(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        await resolved.room.resumeConsumer(input.consumerId);
        ack({ ok: true, data: { consumerId: input.consumerId } });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:close-transport", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuTransport(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        await resolved.room.closeTransport(input.transportId);
        ack({ ok: true, data: { transportId: input.transportId } });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("sfu:close-producer", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuProducer(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      const { call, room } = resolved;
      room.closeProducer(input.producerId);
      call.sfuMedia?.get(socket.data.user.userId)?.producers.delete(input.producerId);
      const event: SfuProducerRemovedEvent = {
        callId: call.id,
        roomId: call.roomId,
        producerId: input.producerId,
        peerId: socket.data.user.userId,
      };
      for (const [participantId, socketId] of call.participants) {
        if (participantId === socket.data.user.userId) continue;
        this.io.sockets.sockets.get(socketId)?.emit("sfu:producer-removed", event);
      }
      ack({ ok: true, data: { producerId: input.producerId } });
    });

    socket.on("sfu:close-consumer", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validSfuConsumer(input, ack)) return;
      const resolved = await this.sfuCall(socket, input, ack);
      if (!resolved) return;
      try {
        resolved.room.closeConsumer(input.consumerId);
        ack({ ok: true, data: { consumerId: input.consumerId } });
      } catch (error) {
        ack(errorResult("SFU_ERROR", errorMessage(error)));
      }
    });

    socket.on("webrtc:offer", async (input, ack) => this.relayDescription(socket, input, ack, "webrtc:offer"));
    socket.on("webrtc:answer", async (input, ack) => this.relayDescription(socket, input, ack, "webrtc:answer"));
    socket.on("webrtc:ice-candidate", async (input, ack) => {
      if (!this.ready(socket, ack) || !this.validCandidate(input, ack)) return;
      const call = await this.callFor(socket, input, ack, "participant", "active");
      if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
      const targetSocketId = socket.id === call.callerSocketId ? call.recipientSocketId : call.callerSocketId;
      this.io.to(targetSocketId).emit("webrtc:ice-candidate", {
        callId: call.id,
        roomId: call.roomId,
        senderId: socket.data.user.userId,
        candidate: input.candidate,
      });
      ack({ ok: true, data: { callId: call.id } });
    });
  }

  private ready<T>(socket: TypedSocket, ack: (result: Result<T>) => void): boolean {
    if (!socket.data.protocolAccepted) {
      ack(errorResult("PROTOCOL_MISMATCH", "Complete the protocol handshake first."));
      return false;
    }
    if (this.exceededRateLimit(socket)) {
      ack(errorResult("RATE_LIMITED", "Too many requests. Slow down and try again."));
      return false;
    }
    return true;
  }
  private allowsOrigin(origin: string | string[] | undefined): boolean {
    const allowed = this.options.origin;
    if (!allowed) return true;
    if (typeof allowed === "function") return allowed(origin === undefined ? undefined : String(origin));
    if (origin === undefined) return true;
    const value = String(origin);
    if (Array.isArray(allowed)) return allowed.includes(value);
    if (allowed instanceof RegExp) return allowed.test(value);
    return allowed === value;
  }

  private exceededRateLimit(socket: TypedSocket): boolean {
    const options = this.options.rateLimit;
    if (!options) return false;
    const windowMs = options.windowMs ?? 1000;
    const max = options.max ?? 100;
    const now = Date.now();
    let rate = socket.data.rate;
    if (!rate || now - rate.windowStart >= windowMs) {
      rate = { windowStart: now, count: 0 };
      socket.data.rate = rate;
    }
    rate.count += 1;
    return rate.count > max;
  }

  private validJoin<T>(input: JoinRoomInput, ack: (result: Result<T>) => void): boolean {
    if (validRoom(input?.roomId)) return true;
    ack(invalid("roomId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validMessage<T>(input: SendMessageInput, ack: (result: Result<T>) => void): boolean {
    if (!validRoom(input?.roomId)) {
      ack(invalid("roomId must be valid."));
      return false;
    }
    if (typeof input.content !== "string" || !input.content.trim() || input.content.length > 10_000) {
      ack(invalid("content must be a non-empty string up to 10,000 characters."));
      return false;
    }
    return true;
  }

  private validTyping<T>(
    input: { roomId: unknown; isTyping: unknown },
    ack: (result: Result<T>) => void,
  ): input is { roomId: string; isTyping: boolean } {
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

  private validCallId<T, I extends { callId?: unknown }>(
    input: I,
    ack: (result: Result<T>) => void,
  ): input is I & CallResponseInput {
    if (typeof input?.callId === "string" && input.callId.length > 0 && input.callId.length <= 200) return true;
    ack(invalid("callId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validDescription<T>(
    input: { callId?: unknown; description?: { type?: unknown; sdp?: unknown } },
    ack: (result: Result<T>) => void,
  ): boolean {
    if (!this.validCallId(input, ack)) return false;
    if (
      (input.description?.type === "offer" || input.description?.type === "answer") &&
      typeof input.description.sdp === "string" &&
      input.description.sdp.length > 0 &&
      input.description.sdp.length <= 200_000
    )
      return true;
    ack(invalid("description must contain an offer or answer with a non-empty SDP string."));
    return false;
  }

  private validCandidate<T>(
    input: {
      callId?: unknown;
      candidate?: { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown; usernameFragment?: unknown };
    },
    ack: (result: Result<T>) => void,
  ): boolean {
    if (!this.validCallId(input, ack)) return false;
    const candidate = input.candidate;
    if (typeof candidate?.candidate !== "string" || candidate.candidate.length > 10_000) {
      ack(invalid("candidate must contain a valid candidate string."));
      return false;
    }
    if (candidate.sdpMid !== undefined && candidate.sdpMid !== null && typeof candidate.sdpMid !== "string") {
      ack(invalid("candidate.sdpMid must be a string or null."));
      return false;
    }
    if (
      candidate.sdpMLineIndex !== undefined &&
      candidate.sdpMLineIndex !== null &&
      (typeof candidate.sdpMLineIndex !== "number" ||
        !Number.isInteger(candidate.sdpMLineIndex) ||
        candidate.sdpMLineIndex < 0)
    ) {
      ack(invalid("candidate.sdpMLineIndex must be a non-negative integer or null."));
      return false;
    }
    if (
      candidate.usernameFragment !== undefined &&
      candidate.usernameFragment !== null &&
      typeof candidate.usernameFragment !== "string"
    ) {
      ack(invalid("candidate.usernameFragment must be a string or null."));
      return false;
    }
    return true;
  }

  private validGroupTarget<T>(input: { targetId?: unknown }, ack: (result: Result<T>) => void): boolean {
    if (typeof input.targetId !== "string" || !input.targetId || input.targetId.length > 200) {
      ack(invalid("targetId must be a non-empty string no longer than 200 characters."));
      return false;
    }
    return true;
  }

  private validGroupCandidate<T>(
    input: {
      callId?: unknown;
      targetId?: unknown;
      candidate?: { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown; usernameFragment?: unknown };
    },
    ack: (result: Result<T>) => void,
  ): boolean {
    if (!this.validCallId(input, ack) || !this.validGroupTarget(input, ack)) return false;
    return this.validCandidate(input, ack);
  }

  private validSfuDirection<T>(
    input: { direction?: unknown },
    ack: (result: Result<T>) => void,
  ): input is { direction: SfuTransportDirection } {
    if (input.direction === "send" || input.direction === "recv") return true;
    ack(invalid("direction must be send or recv."));
    return false;
  }

  private validSfuTransport<T, I extends { callId?: unknown; transportId?: unknown }>(
    input: I,
    ack: (result: Result<T>) => void,
  ): input is I & { callId: string; transportId: string } {
    if (!this.validCallId(input, ack)) return false;
    if (typeof input.transportId === "string" && input.transportId.length > 0 && input.transportId.length <= 200)
      return true;
    ack(invalid("transportId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validSfuProducer<T>(
    input: { callId?: unknown; producerId?: unknown },
    ack: (result: Result<T>) => void,
  ): input is { callId: string; producerId: string } {
    if (!this.validCallId(input, ack)) return false;
    if (typeof input.producerId === "string" && input.producerId.length > 0 && input.producerId.length <= 200)
      return true;
    ack(invalid("producerId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validSfuConsumer<T>(
    input: { callId?: unknown; consumerId?: unknown },
    ack: (result: Result<T>) => void,
  ): input is { callId: string; consumerId: string } {
    if (!this.validCallId(input, ack)) return false;
    if (typeof input.consumerId === "string" && input.consumerId.length > 0 && input.consumerId.length <= 200)
      return true;
    ack(invalid("consumerId must be a non-empty string no longer than 200 characters."));
    return false;
  }

  private validSfuConnect<T>(
    input: { callId?: unknown; transportId?: unknown; dtlsParameters?: unknown },
    ack: (result: Result<T>) => void,
  ): input is { callId: string; transportId: string; dtlsParameters: SfuDtlsParameters } {
    if (!this.validSfuTransport(input, ack)) return false;
    const fingerprints = (input.dtlsParameters as { fingerprints?: unknown } | undefined)?.fingerprints;
    if (
      typeof input.dtlsParameters === "object" &&
      input.dtlsParameters !== null &&
      Array.isArray(fingerprints) &&
      fingerprints.length > 0
    )
      return true;
    ack(invalid("dtlsParameters must contain a non-empty fingerprints array."));
    return false;
  }

  private validSfuProduce<T>(
    input: { callId?: unknown; transportId?: unknown; kind?: unknown; rtpParameters?: unknown },
    ack: (result: Result<T>) => void,
  ): input is {
    callId: string;
    transportId: string;
    kind: "audio" | "video";
    rtpParameters: SfuRtpParameters;
    appData?: Record<string, unknown>;
  } {
    if (!this.validSfuTransport(input, ack)) return false;
    if (input.kind !== "audio" && input.kind !== "video") {
      ack(invalid("kind must be audio or video."));
      return false;
    }
    if (typeof input.rtpParameters !== "object" || input.rtpParameters === null) {
      ack(invalid("rtpParameters must be an object."));
      return false;
    }
    return true;
  }

  private validSfuConsume<T>(
    input: { callId?: unknown; transportId?: unknown; producerId?: unknown; rtpCapabilities?: unknown },
    ack: (result: Result<T>) => void,
  ): input is { callId: string; transportId: string; producerId: string; rtpCapabilities: SfuRtpCapabilities } {
    if (!this.validSfuTransport(input, ack)) return false;
    if (typeof input.producerId !== "string" || !input.producerId || input.producerId.length > 200) {
      ack(invalid("producerId must be a non-empty string no longer than 200 characters."));
      return false;
    }
    if (typeof input.rtpCapabilities !== "object" || input.rtpCapabilities === null) {
      ack(invalid("rtpCapabilities must be an object."));
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
    for (const call of [...this.calls.values()]) {
      if (call.callerSocketId === socket.id || call.recipientSocketId === socket.id)
        this.finishCall(call, "disconnected", socket.data.user.userId, false);
    }
    for (const call of [...this.groupCalls.values()]) {
      if (call.participants.has(socket.data.user.userId) || call.invitees.has(socket.data.user.userId)) {
        this.leaveGroupCall(call, socket.data.user.userId, "disconnected");
      }
    }
  }

  private async userIdsInRoom(roomId: string, exceptSocketId?: string): Promise<string[]> {
    const sockets = await this.io.in(roomId).fetchSockets();
    return [
      ...new Set(
        sockets
          .filter((socket) => socket.id !== exceptSocketId)
          .map((socket) => socket.data.user?.userId)
          .filter((userId): userId is string => Boolean(userId)),
      ),
    ];
  }

  private async userIsPresent(roomId: string, userId: string, exceptSocketId?: string): Promise<boolean> {
    return (await this.userIdsInRoom(roomId, exceptSocketId)).includes(userId);
  }

  private async allowed<T>(
    socket: TypedSocket,
    roomId: string,
    action: RoomAction,
    ack: (result: Result<T>) => void,
  ): Promise<boolean> {
    if (!this.options.authorizeRoom || (await this.options.authorizeRoom({ user: socket.data.user, roomId, action })))
      return true;
    ack(errorResult("UNAUTHORIZED", "You are not authorized for this room action."));
    return false;
  }

  /** Resolves an SFU action to the active group call and its media room, with authorization. */
  private async sfuCall(
    socket: TypedSocket,
    input: { callId?: unknown },
    ack: (result: Result<never>) => void,
  ): Promise<{ call: ActiveGroupCall; room: SfuRoomHandle } | undefined> {
    const call = await this.groupCallFor(socket, input, ack, "participant");
    if (!call) return undefined;
    if (call.mediaMode !== "sfu") {
      ack(errorResult("SFU_UNAVAILABLE", "This call does not use the SFU media path."));
      return undefined;
    }
    if (!(await this.allowed(socket, call.roomId, "sfu", ack))) return undefined;
    const room = this.options.sfu?.room(call.roomId);
    if (!room) {
      ack(errorResult("SFU_UNAVAILABLE", "The SFU room for this call is not available."));
      return undefined;
    }
    return { call, room };
  }

  private participantSfu(call: ActiveGroupCall, userId: string): SfuParticipantMedia {
    call.sfuMedia ??= new Map();
    let media = call.sfuMedia.get(userId);
    if (!media) {
      media = { transports: new Set(), producers: new Map() };
      call.sfuMedia.set(userId, media);
    }
    return media;
  }

  private mediaModeFor(roomId: string): SfuMediaMode {
    if (!this.options.sfu) return "mesh";
    if (this.options.useSfuForRoom && !this.options.useSfuForRoom(roomId)) return "mesh";
    return "sfu";
  }

  /** Starts the SFU lazily, creates (or reuses) the room's Router, and ref-counts its usage. */
  private async ensureSfuRoom(roomId: string): Promise<SfuRoomHandle> {
    const sfu = this.options.sfu;
    if (!sfu) throw new Error("No SFU is configured for this server.");
    await sfu.start();
    const count = this.sfuRooms.get(roomId) ?? 0;
    if (count === 0) await sfu.createRoom(roomId);
    this.sfuRooms.set(roomId, count + 1);
    const room = sfu.room(roomId);
    if (!room) throw new Error(`The SFU room for ${roomId} could not be created.`);
    return room;
  }

  private releaseSfuRoom(roomId: string): void {
    const count = (this.sfuRooms.get(roomId) ?? 1) - 1;
    if (count <= 0) {
      this.sfuRooms.delete(roomId);
      this.options.sfu?.closeRoom(roomId);
    } else {
      this.sfuRooms.set(roomId, count);
    }
  }

  /** Closes a departing participant's SFU producers and transports and notifies the remaining participants. */
  private async closeParticipantSfuMedia(call: ActiveGroupCall, userId: string): Promise<void> {
    const room = this.options.sfu?.room(call.roomId);
    const media = call.sfuMedia?.get(userId);
    call.sfuMedia?.delete(userId);
    if (!room || !media) return;
    for (const producerId of media.producers.keys()) {
      room.closeProducer(producerId);
      const event: SfuProducerRemovedEvent = { callId: call.id, roomId: call.roomId, producerId, peerId: userId };
      for (const [, socketId] of call.participants) {
        this.io.sockets.sockets.get(socketId)?.emit("sfu:producer-removed", event);
      }
    }
    for (const transportId of media.transports) await room.closeTransport(transportId);
  }

  private async callFor<T>(
    socket: TypedSocket,
    input: { callId?: unknown },
    ack: (result: Result<T>) => void,
    role: "caller" | "recipient" | "participant",
    state?: ActiveCall["state"],
  ): Promise<ActiveCall | undefined> {
    if (!this.ready(socket, ack) || !this.validCallId(input, ack)) return undefined;
    const call = this.calls.get(input.callId);
    if (!call) {
      ack(errorResult("CALL_NOT_FOUND", "The call no longer exists."));
      return undefined;
    }
    const isCaller = call.callerSocketId === socket.id;
    const isRecipient = call.recipientSocketId === socket.id;
    if (
      (role === "caller" && !isCaller) ||
      (role === "recipient" && !isRecipient) ||
      (role === "participant" && !isCaller && !isRecipient)
    ) {
      ack(errorResult("UNAUTHORIZED", "You are not a participant in this call."));
      return undefined;
    }
    if (state && call.state !== state) {
      ack(errorResult("CALL_INVALID_STATE", `This action is not available while the call is ${call.state}.`));
      return undefined;
    }
    return call;
  }

  private async groupCallFor<T>(
    socket: TypedSocket,
    input: { callId?: unknown },
    ack: (result: Result<T>) => void,
    role: "caller" | "participant" | "invitee",
    state?: ActiveGroupCall["state"],
  ): Promise<ActiveGroupCall | undefined> {
    if (!this.ready(socket, ack) || !this.validCallId(input, ack)) return undefined;
    const call = this.groupCalls.get(input.callId);
    if (!call) {
      ack(errorResult("CALL_NOT_FOUND", "The call no longer exists."));
      return undefined;
    }
    const isCaller = call.callerSocketId === socket.id;
    const isParticipant = call.participants.has(socket.data.user.userId);
    const isInvitee = call.invitees.has(socket.data.user.userId);
    if (
      (role === "caller" && !isCaller) ||
      (role === "participant" && !isParticipant) ||
      (role === "invitee" && !isInvitee)
    ) {
      ack(errorResult("UNAUTHORIZED", "You are not authorized for this action on the call."));
      return undefined;
    }
    if (state && call.state !== state) {
      ack(errorResult("CALL_INVALID_STATE", `This action is not available while the call is ${call.state}.`));
      return undefined;
    }
    return call;
  }

  private async relayDescription<T>(
    socket: TypedSocket,
    input: { callId?: unknown; description?: { type?: unknown; sdp?: unknown } },
    ack: (result: Result<T>) => void,
    event: "webrtc:offer" | "webrtc:answer",
  ): Promise<void> {
    if (!this.ready(socket, ack) || !this.validDescription(input, ack)) return;
    const call = await this.callFor(socket, input, ack, "participant", "active");
    if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
    const targetSocketId = socket.id === call.callerSocketId ? call.recipientSocketId : call.callerSocketId;
    this.io.to(targetSocketId).emit(event, {
      callId: call.id,
      roomId: call.roomId,
      senderId: socket.data.user.userId,
      description: input.description as { type: "offer" | "answer"; sdp: string },
    });
    ack({ ok: true, data: { callId: call.id } } as Result<T>);
  }

  private async relayGroupDescription<T>(
    socket: TypedSocket,
    input: { callId?: unknown; targetId?: unknown; description?: { type?: unknown; sdp?: unknown } },
    ack: (result: Result<T>) => void,
    event: "group:webrtc:offer" | "group:webrtc:answer",
  ): Promise<void> {
    if (
      !this.ready(socket, ack) ||
      !this.validCallId(input, ack) ||
      !this.validGroupTarget(input, ack) ||
      !this.validDescription(input, ack)
    )
      return;
    const call = await this.groupCallFor(socket, input, ack, "participant", "active");
    if (!call || !(await this.allowed(socket, call.roomId, "webrtc", ack))) return;
    const targetSocketId = call.participants.get(input.targetId as string);
    if (!targetSocketId)
      return ack(errorResult("UNAUTHORIZED", "The signaling target is not a participant in this call."));
    this.io.to(targetSocketId).emit(event, {
      callId: call.id,
      roomId: call.roomId,
      senderId: socket.data.user.userId,
      targetId: input.targetId as string,
      description: input.description as { type: "offer" | "answer"; sdp: string },
    });
    ack({ ok: true, data: { callId: call.id } } as Result<T>);
  }

  private leaveGroupCall(call: ActiveGroupCall, userId: string, reason: CallEndReason): void {
    const wasParticipant = call.participants.delete(userId);
    const wasInvitee = call.invitees.delete(userId);
    if (!wasParticipant && !wasInvitee) return;
    if (call.mediaMode === "sfu" && wasParticipant) void this.closeParticipantSfuMedia(call, userId);
    const participantIds = [...call.participants.keys()];
    for (const [participantId, socketId] of call.participants) {
      this.io.sockets.sockets.get(socketId)?.emit("group:call:participant-left", {
        callId: call.id,
        roomId: call.roomId,
        participantId: userId,
        participantIds,
        selfId: participantId,
      });
    }
    if (call.participants.size === 0) this.finishGroupCall(call, reason, userId);
  }

  private endCall(callId: string, reason: CallEndReason): void {
    const call = this.calls.get(callId);
    if (call) this.finishCall(call, reason);
  }

  private endGroupCall(callId: string, reason: CallEndReason): void {
    const call = this.groupCalls.get(callId);
    if (call) this.finishGroupCall(call, reason);
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

  private finishGroupCall(call: ActiveGroupCall, reason: CallEndReason, endedById?: string): void {
    if (!this.groupCalls.delete(call.id)) return;
    clearTimeout(call.timeout);
    if (call.mediaMode === "sfu") {
      const room = this.options.sfu?.room(call.roomId);
      for (const media of call.sfuMedia?.values() ?? []) {
        for (const producerId of media.producers.keys()) room?.closeProducer(producerId);
        for (const transportId of media.transports) void room?.closeTransport(transportId);
      }
      this.releaseSfuRoom(call.roomId);
    }
    const event = { callId: call.id, roomId: call.roomId, endedById, reason };
    const socketIds = new Set<string>([...call.participants.values(), ...call.invitees.values()]);
    for (const socketId of socketIds) this.io.to(socketId).emit("call:ended", event);
  }
}

export const createRealtimeServer = (options: RealtimeServerOptions): RealtimeServer => new RealtimeServer(options);
