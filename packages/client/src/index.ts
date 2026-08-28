import { io, type Socket, type ManagerOptions, type SocketOptions } from "socket.io-client";
import {
  PROTOCOL_VERSION,
  type CallAcceptedEvent,
  type CallEndedEvent,
  type CallIncomingEvent,
  type CallMediaType,
  type CallRejectedEvent,
  type ClientToServerEvents,
  type IceServer,
  type JoinRoomInput,
  type MessageDeliveredEvent,
  type RealtimeMessage,
  type Result,
  type RoomPresenceEvent,
  type ServerToClientEvents,
  type TypingEvent,
  type WebRtcIceCandidate,
  type WebRtcIceCandidateEvent,
  type WebRtcDescriptionEvent,
  type WebRtcSessionDescription
} from "@realtimesdk/core";

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
  "call:incoming": (call: RealtimeCall) => void;
  "call:accepted": (call: RealtimeCall) => void;
  "call:rejected": (call: RealtimeCall) => void;
  "call:ended": (call: RealtimeCall, event: CallEndedEvent) => void;
  "call:state": (call: RealtimeCall) => void;
  "call:stream": (call: RealtimeCall, stream: MediaStream) => void;
  "webrtc:offer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:answer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:ice-candidate": (payload: WebRtcIceCandidateEvent) => void;
};
type Listener<T extends keyof ClientEvents> = ClientEvents[T];

export type RealtimeCallState = "ringing" | "connecting" | "active" | "ended";
export type RealtimeCall = {
  id: string;
  roomId: string;
  remoteUserId: string;
  mediaType: CallMediaType;
  state: RealtimeCallState;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  isScreenSharing?: boolean;
};
export type RealtimeClientOptions = Partial<ManagerOptions & SocketOptions> & {
  /** STUN/TURN servers supplied by the application; no provider is imposed. */
  iceServers?: IceServer[];
  /** Constraints used by startAudioCall and answerAudioCall. Defaults to audio only. */
  audioConstraints?: MediaStreamConstraints;
  /** Constraints used by startVideoCall and answerVideoCall. Defaults to camera and microphone. */
  videoConstraints?: MediaStreamConstraints;
  /** Constraints used by startScreenShare. Defaults to sharing video without system audio. */
  screenShareConstraints?: DisplayMediaStreamOptions;
};
type ManagedCall = RealtimeCall & { connection?: RTCPeerConnection; pendingCandidates: WebRtcIceCandidate[]; screenStream?: MediaStream };

export class RealtimeClient {
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private readonly listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private readonly desiredRooms = new Set<string>();
  private readonly calls = new Map<string, ManagedCall>();
  private handshake?: Promise<void>;
  private hasConnected = false;
  private readonly pageHideHandler?: () => void;

  constructor(url: string, private readonly options: RealtimeClientOptions = {}) {
    this.socket = io(url, { autoConnect: false, closeOnBeforeunload: true, ...options });
    this.socket.on("connect", () => { void this.onConnected(); });
    this.socket.on("disconnect", (reason) => {
      this.handshake = undefined;
      this.endAllCalls("disconnected");
      this.emit("disconnected", reason);
    });
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
    this.socket.on("call:incoming", (payload) => this.onCallIncoming(payload));
    this.socket.on("call:accepted", (payload) => { void this.onCallAccepted(payload); });
    this.socket.on("call:rejected", (payload) => this.onCallRejected(payload));
    this.socket.on("call:ended", (payload) => this.onCallEnded(payload));
    this.socket.on("webrtc:offer", (payload) => { this.emit("webrtc:offer", payload); void this.onOffer(payload); });
    this.socket.on("webrtc:answer", (payload) => { this.emit("webrtc:answer", payload); void this.onAnswer(payload); });
    this.socket.on("webrtc:ice-candidate", (payload) => { this.emit("webrtc:ice-candidate", payload); void this.onIceCandidate(payload); });
    if (typeof window !== "undefined") {
      this.pageHideHandler = () => this.disconnect();
      window.addEventListener("pagehide", this.pageHideHandler);
    }
  }

  connect(): void { this.socket.connect(); }
  disconnect(): void { this.socket.disconnect(); this.handshake = undefined; this.endAllCalls("disconnected"); }
  destroy(): void {
    if (this.pageHideHandler && typeof window !== "undefined") window.removeEventListener("pagehide", this.pageHideHandler);
    this.disconnect();
    for (const call of this.calls.values()) this.releaseCall(call, false);
    this.calls.clear();
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

  /** Starts a one-to-one audio call with the single other user currently in the room. */
  async startAudioCall(roomId: string): Promise<RealtimeCall> {
    const localStream = await this.getAudioStream();
    try {
      const call = await this.startCall(roomId, "audio");
      const managed = this.calls.get(call.id)!;
      managed.localStream = localStream;
      this.emit("call:state", this.snapshot(managed));
      return this.snapshot(managed);
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  /** Starts a one-to-one video call with camera and microphone media. */
  async startVideoCall(roomId: string): Promise<RealtimeCall> {
    const localStream = await this.getVideoStream();
    try {
      const call = await this.startCall(roomId, "video");
      const managed = this.calls.get(call.id)!;
      managed.localStream = localStream;
      this.emit("call:state", this.snapshot(managed));
      return this.snapshot(managed);
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  /** Starts a call without acquiring media, for custom WebRTC integrations. */
  async startCall(roomId: string, mediaType: CallMediaType = "audio"): Promise<RealtimeCall> {
    const result = await this.request<{ callId: string; roomId: string; recipientId: string }>("call:start", { roomId, mediaType });
    const call: ManagedCall = { id: result.callId, roomId: result.roomId, remoteUserId: result.recipientId, mediaType, state: "ringing", pendingCandidates: [] };
    this.calls.set(call.id, call);
    this.emit("call:state", this.snapshot(call));
    return this.snapshot(call);
  }

  /** Accepts an incoming audio call and begins WebRTC negotiation. */
  async answerAudioCall(callId: string): Promise<RealtimeCall> {
    const call = this.requireCall(callId, "ringing");
    if (call.mediaType !== "audio") throw new Error("This is a video call. Use answerVideoCall instead.");
    call.localStream = await this.getAudioStream();
    this.createPeerConnection(call);
    try {
      await this.request("call:accept", { callId });
      this.setCallState(call, "connecting");
      return this.snapshot(call);
    } catch (error) {
      this.releaseCall(call, true);
      throw error;
    }
  }

  /** Accepts an incoming video call with camera and microphone media. */
  async answerVideoCall(callId: string): Promise<RealtimeCall> {
    const call = this.requireCall(callId, "ringing");
    if (call.mediaType !== "video") throw new Error("This is an audio call. Use answerAudioCall instead.");
    call.localStream = await this.getVideoStream();
    this.createPeerConnection(call);
    try {
      await this.request("call:accept", { callId });
      this.setCallState(call, "connecting");
      return this.snapshot(call);
    } catch (error) {
      this.releaseCall(call, true);
      throw error;
    }
  }

  /** Adds a display-video track to an active call and renegotiates the peer connection. */
  async startScreenShare(callId: string): Promise<MediaStream> {
    const call = this.requireCall(callId);
    if (!call.connection) throw new Error("Screen sharing is available after the call connects.");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing requires browser display media devices.");
    const screenStream = await navigator.mediaDevices.getDisplayMedia(this.options.screenShareConstraints ?? { video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) { screenStream.getTracks().forEach((track) => track.stop()); throw new Error("No screen video track was selected."); }
    call.screenStream?.getTracks().forEach((track) => track.stop());
    call.screenStream = screenStream;
    const videoSender = call.connection.getSenders().find((sender) => sender.track?.kind === "video");
    if (videoSender) await videoSender.replaceTrack(screenTrack);
    else call.connection.addTrack(screenTrack, screenStream);
    screenTrack.onended = () => { if (call.screenStream === screenStream) void this.stopScreenShare(call.id).catch(() => undefined); };
    this.emit("call:state", this.snapshot(call));
    await this.renegotiate(call);
    return screenStream;
  }

  /** Stops display sharing and restores the camera video track when the call has one. */
  async stopScreenShare(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    const screenStream = call.screenStream;
    if (!screenStream || !call.connection) return;
    call.screenStream = undefined;
    const cameraTrack = call.localStream?.getVideoTracks()[0] ?? null;
    const videoSender = call.connection.getSenders().find((sender) => sender.track?.kind === "video");
    if (videoSender) await videoSender.replaceTrack(cameraTrack);
    screenStream.getTracks().forEach((track) => track.stop());
    this.emit("call:state", this.snapshot(call));
    await this.renegotiate(call);
  }

  /** Accepts a call without acquiring media, for custom WebRTC integrations. */
  async acceptCall(callId: string): Promise<RealtimeCall> {
    const call = this.requireCall(callId, "ringing");
    await this.request<{ callId: string }>("call:accept", { callId });
    this.setCallState(call, "connecting");
    return this.snapshot(call);
  }

  async rejectCall(callId: string): Promise<void> {
    const call = this.requireCall(callId, "ringing");
    await this.request("call:reject", { callId });
    this.releaseCall(call, true, { callId: call.id, roomId: call.roomId, reason: "rejected" });
  }

  async hangupCall(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    await this.request("call:hangup", { callId });
    // The server also echoes call:ended; this makes cleanup immediate if a transport closes first.
    this.releaseCall(call, true);
  }

  getCall(callId: string): RealtimeCall | undefined {
    const call = this.calls.get(callId);
    return call && this.snapshot(call);
  }

  /** Advanced signaling API for applications that manage their own RTCPeerConnection. */
  async sendOffer(callId: string, description: WebRtcSessionDescription): Promise<void> { await this.request("webrtc:offer", { callId, description }); }
  async sendAnswer(callId: string, description: WebRtcSessionDescription): Promise<void> { await this.request("webrtc:answer", { callId, description }); }
  async sendIceCandidate(callId: string, candidate: WebRtcIceCandidate): Promise<void> { await this.request("webrtc:ice-candidate", { callId, candidate }); }

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

  private async request<T>(event: "call:start" | "call:accept" | "call:reject" | "call:hangup" | "webrtc:offer" | "webrtc:answer" | "webrtc:ice-candidate", input: unknown): Promise<T> {
    await this.ensureHandshake();
    const emit = this.socket as unknown as { emit: (name: string, payload: unknown, ack: (result: Result<T>) => void) => void };
    return new Promise((resolve, reject) => emit.emit(event, input, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    }));
  }

  private onCallIncoming(payload: CallIncomingEvent): void {
    const call: ManagedCall = { id: payload.callId, roomId: payload.roomId, remoteUserId: payload.callerId, mediaType: payload.mediaType, state: "ringing", pendingCandidates: [] };
    this.calls.set(call.id, call);
    this.emit("call:incoming", this.snapshot(call));
    this.emit("call:state", this.snapshot(call));
  }

  private async onCallAccepted(payload: CallAcceptedEvent): Promise<void> {
    const call = this.calls.get(payload.callId);
    if (!call || call.state === "ended") return;
    this.emit("call:accepted", this.snapshot(call));
    // A call created with startCall is intentionally left to the application's
    // advanced signaling integration; startAudioCall supplies a local stream.
    if (!call.localStream) { this.setCallState(call, "connecting"); return; }
    try {
      this.createPeerConnection(call);
      this.setCallState(call, "connecting");
      const offer = await call.connection!.createOffer();
      await call.connection!.setLocalDescription(offer);
      await this.sendOffer(call.id, this.description(call.connection!.localDescription));
    } catch (reason) {
      this.emit("error", reason instanceof Error ? reason : new Error("Unable to create the WebRTC offer."));
      void this.hangupCall(call.id).catch(() => this.releaseCall(call, true));
    }
  }

  private onCallRejected(payload: CallRejectedEvent): void {
    const call = this.calls.get(payload.callId);
    if (!call) return;
    this.emit("call:rejected", this.snapshot(call));
    this.releaseCall(call, true, { callId: call.id, roomId: call.roomId, endedById: payload.recipientId, reason: "rejected" });
  }

  private onCallEnded(payload: CallEndedEvent): void {
    const call = this.calls.get(payload.callId);
    if (!call) return;
    this.releaseCall(call, true, payload);
  }

  private async onOffer(payload: { callId: string; description: WebRtcSessionDescription }): Promise<void> {
    const call = this.calls.get(payload.callId);
    if (!call?.connection) return;
    try {
      await call.connection.setRemoteDescription(payload.description);
      await this.flushCandidates(call);
      const answer = await call.connection.createAnswer();
      await call.connection.setLocalDescription(answer);
      await this.sendAnswer(call.id, this.description(call.connection.localDescription));
    } catch (reason) { this.emit("error", reason instanceof Error ? reason : new Error("Unable to answer the WebRTC offer.")); }
  }

  private async renegotiate(call: ManagedCall): Promise<void> {
    if (!call.connection || call.connection.signalingState !== "stable") throw new Error("The call is busy negotiating. Try screen sharing again in a moment.");
    const offer = await call.connection.createOffer();
    await call.connection.setLocalDescription(offer);
    await this.sendOffer(call.id, this.description(call.connection.localDescription));
  }

  private async onAnswer(payload: { callId: string; description: WebRtcSessionDescription }): Promise<void> {
    const call = this.calls.get(payload.callId);
    if (!call?.connection) return;
    try { await call.connection.setRemoteDescription(payload.description); await this.flushCandidates(call); }
    catch (reason) { this.emit("error", reason instanceof Error ? reason : new Error("Unable to apply the WebRTC answer.")); }
  }

  private async onIceCandidate(payload: WebRtcIceCandidateEvent): Promise<void> {
    const call = this.calls.get(payload.callId);
    if (!call?.connection) return;
    if (!call.connection.remoteDescription) { call.pendingCandidates.push(payload.candidate); return; }
    try { await call.connection.addIceCandidate(payload.candidate); }
    catch (reason) { this.emit("error", reason instanceof Error ? reason : new Error("Unable to add the ICE candidate.")); }
  }

  private createPeerConnection(call: ManagedCall): void {
    if (call.connection) return;
    if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is only available in a browser runtime.");
    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers });
    call.connection = connection;
    for (const track of call.localStream?.getTracks() ?? []) connection.addTrack(track, call.localStream!);
    connection.onicecandidate = (event) => { if (event.candidate) void this.sendIceCandidate(call.id, this.candidate(event.candidate)).catch((reason) => this.emit("error", reason instanceof Error ? reason : new Error("Unable to send an ICE candidate."))); };
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      call.remoteStream = stream;
      this.setCallState(call, "active");
      this.emit("call:state", this.snapshot(call));
      this.emit("call:stream", this.snapshot(call), stream);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        void this.hangupCall(call.id).catch(() => this.releaseCall(call, true));
      }
    };
  }

  private async flushCandidates(call: ManagedCall): Promise<void> {
    while (call.pendingCandidates.length) await call.connection!.addIceCandidate(call.pendingCandidates.shift()!);
  }

  private getAudioStream(): Promise<MediaStream> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("Audio calls require browser media devices."));
    return navigator.mediaDevices.getUserMedia(this.options.audioConstraints ?? { audio: true, video: false });
  }

  private getVideoStream(): Promise<MediaStream> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return Promise.reject(new Error("Video calls require browser media devices."));
    return navigator.mediaDevices.getUserMedia(this.options.videoConstraints ?? { audio: true, video: true });
  }

  private requireCall(callId: string, expectedState?: RealtimeCallState): ManagedCall {
    const call = this.calls.get(callId);
    if (!call || call.state === "ended") throw new Error("The call no longer exists.");
    if (expectedState && call.state !== expectedState) throw new Error(`The call is ${call.state}, not ${expectedState}.`);
    return call;
  }

  private setCallState(call: ManagedCall, state: RealtimeCallState): void {
    if (call.state === state) return;
    call.state = state;
    this.emit("call:state", this.snapshot(call));
  }

  private releaseCall(call: ManagedCall, remove: boolean, ended?: CallEndedEvent): void {
    const connection = call.connection;
    call.connection = undefined;
    if (connection) { connection.onconnectionstatechange = null; connection.close(); }
    call.localStream?.getTracks().forEach((track) => track.stop());
    call.screenStream?.getTracks().forEach((track) => track.stop());
    call.localStream = undefined;
    call.screenStream = undefined;
    call.pendingCandidates = [];
    call.state = "ended";
    this.emit("call:state", this.snapshot(call));
    if (ended) this.emit("call:ended", this.snapshot(call), ended);
    if (remove) this.calls.delete(call.id);
  }

  private endAllCalls(reason: CallEndedEvent["reason"]): void {
    for (const call of [...this.calls.values()]) {
      this.releaseCall(call, true, { callId: call.id, roomId: call.roomId, reason });
    }
  }

  private snapshot(call: ManagedCall): RealtimeCall {
    return { id: call.id, roomId: call.roomId, remoteUserId: call.remoteUserId, mediaType: call.mediaType, state: call.state, localStream: call.localStream, remoteStream: call.remoteStream, isScreenSharing: Boolean(call.screenStream) };
  }

  private description(value: RTCSessionDescription | null): WebRtcSessionDescription {
    if (!value?.sdp || (value.type !== "offer" && value.type !== "answer")) throw new Error("WebRTC did not create a valid session description.");
    return { type: value.type, sdp: value.sdp };
  }

  private candidate(value: RTCIceCandidate): WebRtcIceCandidate {
    return { candidate: value.candidate, sdpMid: value.sdpMid, sdpMLineIndex: value.sdpMLineIndex, usernameFragment: value.usernameFragment };
  }

  private emit<T extends keyof ClientEvents>(event: T, ...args: Parameters<ClientEvents[T]>): void {
    this.listeners.get(event)?.forEach((listener) => (listener as (...values: Parameters<ClientEvents[T]>) => void)(...args));
  }
}

export const createRealtimeClient = (url: string, options?: RealtimeClientOptions): RealtimeClient => new RealtimeClient(url, options);
