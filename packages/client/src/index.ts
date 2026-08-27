import { io, type Socket, type ManagerOptions, type SocketOptions } from "socket.io-client";
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type JoinRoomInput,
  type MessageDeliveredEvent,
  type RealtimeMessage,
  type RoomPresenceEvent,
  type ServerToClientEvents,
  type TypingEvent
} from "@realtime/core";

type ClientEvents = {
  connected: () => void;
  reconnected: () => void;
  disconnected: (reason: string) => void;
  error: (error: Error) => void;
  message: (message: RealtimeMessage) => void;
  "room:joined": (payload: { roomId: string; userId: string }) => void;
  "room:left": (payload: { roomId: string; userId: string }) => void;
  "presence:state": (payload: { roomId: string; userIds: string[] }) => void;
  "user:online": (payload: RoomPresenceEvent) => void;
  "user:offline": (payload: RoomPresenceEvent) => void;
  "typing:start": (payload: TypingEvent) => void;
  "typing:stop": (payload: TypingEvent) => void;
  "message:delivered": (payload: MessageDeliveredEvent) => void;
};
type Listener<T extends keyof ClientEvents> = ClientEvents[T];

export type RealtimeClientOptions = Partial<ManagerOptions & SocketOptions>;

export class RealtimeClient {
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private readonly listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private readonly desiredRooms = new Set<string>();
  private handshake?: Promise<void>;
  private hasConnected = false;
  private readonly pageHideHandler?: () => void;

  constructor(url: string, options: RealtimeClientOptions = {}) {
    this.socket = io(url, { autoConnect: false, closeOnBeforeunload: true, ...options });
    this.socket.on("connect", () => { void this.onConnected(); });
    this.socket.on("disconnect", (reason) => { this.handshake = undefined; this.emit("disconnected", reason); });
    this.socket.on("connect_error", (error) => this.emit("error", error));
    this.socket.on("message", (message) => this.emit("message", message));
    this.socket.on("room:joined", (payload) => this.emit("room:joined", payload));
    this.socket.on("room:left", (payload) => this.emit("room:left", payload));
    this.socket.on("presence:state", (payload) => this.emit("presence:state", payload));
    this.socket.on("user:online", (payload) => this.emit("user:online", payload));
    this.socket.on("user:offline", (payload) => this.emit("user:offline", payload));
    this.socket.on("typing:start", (payload) => this.emit("typing:start", payload));
    this.socket.on("typing:stop", (payload) => this.emit("typing:stop", payload));
    this.socket.on("message:delivered", (payload) => this.emit("message:delivered", payload));
    if (typeof window !== "undefined") {
      this.pageHideHandler = () => this.disconnect();
      window.addEventListener("pagehide", this.pageHideHandler);
    }
  }

  connect(): void { this.socket.connect(); }
  disconnect(): void { this.socket.disconnect(); this.handshake = undefined; }
  destroy(): void {
    if (this.pageHideHandler && typeof window !== "undefined") window.removeEventListener("pagehide", this.pageHideHandler);
    this.disconnect();
    this.listeners.clear();
  }
  get connected(): boolean { return this.socket.connected; }

  on<T extends keyof ClientEvents>(event: T, listener: Listener<T>): () => void {
    const current = this.listeners.get(event) ?? new Set();
    current.add(listener as (...args: never[]) => void);
    this.listeners.set(event, current);
    return () => current.delete(listener as (...args: never[]) => void);
  }

  async joinRoom(roomId: string): Promise<void> { await this.roomRequest("room:join", { roomId }); this.desiredRooms.add(roomId); }
  async leaveRoom(roomId: string): Promise<void> { await this.roomRequest("room:leave", { roomId }); this.desiredRooms.delete(roomId); }
  async sendMessage(roomId: string, content: string, clientMessageId?: string): Promise<RealtimeMessage> {
    await this.ensureHandshake();
    return new Promise((resolve, reject) => this.socket.emit("message:send", { roomId, content, clientMessageId }, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    }));
  }

  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    await this.ensureHandshake();
    return new Promise((resolve, reject) => this.socket.emit("typing:set", { roomId, isTyping }, (result) => {
      if (result.ok) resolve();
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    }));
  }

  private async onConnected(): Promise<void> {
    try {
      await this.ensureHandshake();
      await Promise.all([...this.desiredRooms].map((roomId) => this.roomRequest("room:join", { roomId })));
      if (this.hasConnected) this.emit("reconnected");
      else { this.hasConnected = true; this.emit("connected"); }
    }
    catch (error) { this.emit("error", error instanceof Error ? error : new Error("Protocol handshake failed.")); this.socket.disconnect(); }
  }

  private async ensureHandshake(): Promise<void> {
    if (!this.handshake) this.handshake = new Promise<void>((resolve, reject) => {
      this.socket.emit("protocol:handshake", PROTOCOL_VERSION, (result) => result.ok ? resolve() : reject(new Error(`${result.error.code}: ${result.error.message}`)));
    });
    return this.handshake;
  }

  private async roomRequest(event: "room:join" | "room:leave", input: JoinRoomInput): Promise<void> {
    await this.ensureHandshake();
    return new Promise((resolve, reject) => this.socket.emit(event, input, (result) => {
      if (result.ok) resolve();
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    }));
  }

  private emit<T extends keyof ClientEvents>(event: T, ...args: Parameters<ClientEvents[T]>): void {
    this.listeners.get(event)?.forEach((listener) => (listener as (...values: Parameters<ClientEvents[T]>) => void)(...args));
  }
}

export const createRealtimeClient = (url: string, options?: RealtimeClientOptions): RealtimeClient => new RealtimeClient(url, options);
