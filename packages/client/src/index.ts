import { io, type Socket, type ManagerOptions, type SocketOptions } from "socket.io-client";
import {
  PROTOCOL_VERSION,
  type CallAcceptedEvent,
  type CallEndedEvent,
  type CallIncomingEvent,
  type CallMediaType,
  type CallRejectedEvent,
  type ClientToServerEvents,
  type GroupCallIncomingEvent,
  type GroupCallJoinResult,
  type GroupCallParticipantEvent,
  type GroupCallResult,
  type GroupWebRtcDescriptionEvent,
  type GroupWebRtcIceCandidateEvent,
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
  "call:stream": (call: RealtimeCall, stream: MediaStream, peerId?: string) => void;
  "group:call:participant-joined": (call: RealtimeCall, participantId: string) => void;
  "group:call:participant-left": (call: RealtimeCall, participantId: string) => void;
  "webrtc:offer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:answer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:ice-candidate": (payload: WebRtcIceCandidateEvent) => void;
  "group:webrtc:offer": (payload: GroupWebRtcDescriptionEvent) => void;
  "group:webrtc:answer": (payload: GroupWebRtcDescriptionEvent) => void;
  "group:webrtc:ice-candidate": (payload: GroupWebRtcIceCandidateEvent) => void;
};
type Listener<T extends keyof ClientEvents> = ClientEvents[T];

export type RealtimeCallState = "ringing" | "connecting" | "active" | "ended";
export type RealtimeCall = {
  id: string;
  roomId: string;
  isGroup: boolean;
  remoteUserId?: string;
  callerId?: string;
  participantIds: string[];
  mediaType: CallMediaType;
  state: RealtimeCallState;
  localStream?: MediaStream;
  remoteStream?: MediaStream;
  remoteStreams?: Record<string, MediaStream>;
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
type ManagedCall = RealtimeCall & {
  selfId?: string;
  connection?: RTCPeerConnection;
  pendingCandidates: WebRtcIceCandidate[];
  connections?: Map<string, RTCPeerConnection>;
  pendingByPeer?: Map<string, WebRtcIceCandidate[]>;
  screenStream?: MediaStream;
};

export class RealtimeClient {
  private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>;
  private readonly listeners = new Map<keyof ClientEvents, Set<(...args: never[]) => void>>();
  private readonly desiredRooms = new Set<string>();
  private readonly calls = new Map<string, ManagedCall>();
  private selfId?: string;
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
    this.socket.on("group:call:incoming", (payload) => this.onGroupCallIncoming(payload));
    this.socket.on("group:call:participant-joined", (payload) => this.onGroupParticipantJoined(payload));
    this.socket.on("group:call:participant-left", (payload) => this.onGroupParticipantLeft(payload));
    this.socket.on("webrtc:offer", (payload) => { this.emit("webrtc:offer", payload); void this.onOffer(payload); });
    this.socket.on("webrtc:answer", (payload) => { this.emit("webrtc:answer", payload); void this.onAnswer(payload); });
    this.socket.on("webrtc:ice-candidate", (payload) => { this.emit("webrtc:ice-candidate", payload); void this.onIceCandidate(payload); });
    this.socket.on("group:webrtc:offer", (payload) => { this.emit("group:webrtc:offer", payload); void this.onGroupOffer(payload); });
    this.socket.on("group:webrtc:answer", (payload) => { this.emit("group:webrtc:answer", payload); void this.onGroupAnswer(payload); });
    this.socket.on("group:webrtc:ice-candidate", (payload) => { this.emit("group:webrtc:ice-candidate", payload); void this.onGroupIceCandidate(payload); });
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
    const call: ManagedCall = { id: result.callId, roomId: result.roomId, isGroup: false, remoteUserId: result.recipientId, participantIds: [], mediaType, state: "ringing", pendingCandidates: [] };
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
    if (call.isGroup ? (!call.connections || call.connections.size === 0) : !call.connection) throw new Error("Screen sharing is available after the call connects.");
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen sharing requires browser display media devices.");
    const screenStream = await navigator.mediaDevices.getDisplayMedia(this.options.screenShareConstraints ?? { video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) { screenStream.getTracks().forEach((track) => track.stop()); throw new Error("No screen video track was selected."); }
    call.screenStream?.getTracks().forEach((track) => track.stop());
    call.screenStream = screenStream;
    if (call.isGroup) {
      for (const [peerId, connection] of call.connections ?? []) {
        const videoSender = connection.getSenders().find((sender) => sender.track?.kind === "video");
        if (videoSender) await videoSender.replaceTrack(screenTrack);
        else connection.addTrack(screenTrack, screenStream);
        await this.renegotiatePeer(call, peerId, connection);
      }
    } else {
      const videoSender = call.connection!.getSenders().find((sender) => sender.track?.kind === "video");
      if (videoSender) await videoSender.replaceTrack(screenTrack);
      else call.connection!.addTrack(screenTrack, screenStream);
      await this.renegotiate(call);
    }
    screenTrack.onended = () => { if (call.screenStream === screenStream) void this.stopScreenShare(call.id).catch(() => undefined); };
    this.emit("call:state", this.snapshot(call));
    return screenStream;
  }

  /** Stops display sharing and restores the camera video track when the call has one. */
  async stopScreenShare(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    const screenStream = call.screenStream;
    if (!screenStream) return;
    call.screenStream = undefined;
    const cameraTrack = call.localStream?.getVideoTracks()[0] ?? null;
    if (call.isGroup) {
      for (const [peerId, connection] of call.connections ?? []) {
        const videoSender = connection.getSenders().find((sender) => sender.track?.kind === "video");
        if (videoSender) await videoSender.replaceTrack(cameraTrack);
        await this.renegotiatePeer(call, peerId, connection);
      }
    } else {
      if (!call.connection) return;
      const videoSender = call.connection.getSenders().find((sender) => sender.track?.kind === "video");
      if (videoSender) await videoSender.replaceTrack(cameraTrack);
      await this.renegotiate(call);
    }
    screenStream.getTracks().forEach((track) => track.stop());
    this.emit("call:state", this.snapshot(call));
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
    if (call.isGroup) return this.leaveCall(callId);
    await this.request("call:hangup", { callId });
    // The server also echoes call:ended; this makes cleanup immediate if a transport closes first.
    this.releaseCall(call, true);
  }

  /** Starts a group audio or video call that rings every other member currently in the room. */
  async startGroupCall(roomId: string, options?: { video?: boolean }): Promise<RealtimeCall> {
    const mediaType: CallMediaType = options?.video ? "video" : "audio";
    const localStream = mediaType === "video" ? await this.getVideoStream() : await this.getAudioStream();
    try {
      const call = await this.startGroupCallRaw(roomId, mediaType);
      const managed = this.calls.get(call.id)!;
      managed.localStream = localStream;
      this.emit("call:state", this.snapshot(managed));
      return this.snapshot(managed);
    } catch (error) {
      localStream.getTracks().forEach((track) => track.stop());
      throw error;
    }
  }

  /** Advanced integration: starts a group call without acquiring media or creating peer connections. */
  async startGroupCallRaw(roomId: string, mediaType: CallMediaType = "audio"): Promise<RealtimeCall> {
    const result = await this.request<GroupCallResult>("call:start-group", { roomId, mediaType });
    this.selfId = result.selfId;
    const call: ManagedCall = {
      id: result.callId, roomId: result.roomId, isGroup: true, selfId: result.selfId, callerId: result.selfId,
      participantIds: result.participantIds, mediaType, state: "ringing", pendingCandidates: []
    };
    this.calls.set(call.id, call);
    this.emit("call:state", this.snapshot(call));
    return this.snapshot(call);
  }

  /** Joins a ringing group call and connects the caller's mesh of peer connections. */
  async joinCall(callId: string): Promise<RealtimeCall> {
    const call = this.requireCall(callId, "ringing");
    if (!call.isGroup) throw new Error("Use answerAudioCall or answerVideoCall for one-to-one calls.");
    call.localStream = call.mediaType === "video" ? await this.getVideoStream() : await this.getAudioStream();
    try {
      const joined = await this.joinCallRaw(callId);
      const managed = this.calls.get(joined.id)!;
      for (const peer of managed.participantIds.filter((id) => id !== managed.selfId)) {
        const connection = this.groupConnection(managed, peer);
        try {
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          await this.sendGroupOffer(managed.id, peer, this.description(connection.localDescription));
        } catch (reason) {
          this.emit("error", reason instanceof Error ? reason : new Error("Unable to create the WebRTC offer."));
        }
      }
      return this.snapshot(managed);
    } catch (error) {
      this.releaseCall(call, true);
      throw error;
    }
  }

  /** Advanced integration: joins a group call without acquiring media or creating peer connections. */
  async joinCallRaw(callId: string): Promise<RealtimeCall> {
    const call = this.requireCall(callId, "ringing");
    if (!call.isGroup) throw new Error("Use answerAudioCall or answerVideoCall for one-to-one calls.");
    const result = await this.request<GroupCallJoinResult>("call:join", { callId });
    this.selfId = result.selfId;
    call.selfId = result.selfId;
    call.participantIds = result.participantIds;
    this.setCallState(call, "connecting");
    return this.snapshot(call);
  }

  /** Leaves a group call without ending it for the other participants. */
  async leaveCall(callId: string): Promise<void> {
    const call = this.requireCall(callId);
    if (!call.isGroup) throw new Error("Use hangupCall for one-to-one calls.");
    await this.request("call:leave", { callId });
    this.releaseCall(call, true, { callId: call.id, roomId: call.roomId, endedById: call.selfId, reason: "hangup" });
  }

  getCall(callId: string): RealtimeCall | undefined {
    const call = this.calls.get(callId);
    return call && this.snapshot(call);
  }

  /** Advanced signaling API for applications that manage their own RTCPeerConnection. */
  async sendOffer(callId: string, description: WebRtcSessionDescription): Promise<void> { await this.request("webrtc:offer", { callId, description }); }
  async sendAnswer(callId: string, description: WebRtcSessionDescription): Promise<void> { await this.request("webrtc:answer", { callId, description }); }
  async sendIceCandidate(callId: string, candidate: WebRtcIceCandidate): Promise<void> { await this.request("webrtc:ice-candidate", { callId, candidate }); }

  /** Advanced group-call signaling API for applications that manage their own RTCPeerConnections. */
  sendGroupOffer(callId: string, targetId: string, description: WebRtcSessionDescription): Promise<void> { return this.request("group:webrtc:offer", { callId, targetId, description }); }
  sendGroupAnswer(callId: string, targetId: string, description: WebRtcSessionDescription): Promise<void> { return this.request("group:webrtc:answer", { callId, targetId, description }); }
  sendGroupIceCandidate(callId: string, targetId: string, candidate: WebRtcIceCandidate): Promise<void> { return this.request("group:webrtc:ice-candidate", { callId, targetId, candidate }); }

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

  private async request<T>(event: "call:start" | "call:accept" | "call:reject" | "call:hangup" | "call:start-group" | "call:join" | "call:leave" | "webrtc:offer" | "webrtc:answer" | "webrtc:ice-candidate" | "group:webrtc:offer" | "group:webrtc:answer" | "group:webrtc:ice-candidate", input: unknown): Promise<T> {
    await this.ensureHandshake();
    const emit = this.socket as unknown as { emit: (name: string, payload: unknown, ack: (result: Result<T>) => void) => void };
    return new Promise((resolve, reject) => emit.emit(event, input, (result) => {
      if (result.ok) resolve(result.data);
      else reject(new Error(`${result.error.code}: ${result.error.message}`));
    }));
  }

  private onCallIncoming(payload: CallIncomingEvent): void {
    const call: ManagedCall = { id: payload.callId, roomId: payload.roomId, isGroup: false, remoteUserId: payload.callerId, participantIds: [], mediaType: payload.mediaType, state: "ringing", pendingCandidates: [] };
    this.calls.set(call.id, call);
    this.emit("call:incoming", this.snapshot(call));
    this.emit("call:state", this.snapshot(call));
  }

  private onGroupCallIncoming(payload: GroupCallIncomingEvent): void {
    this.selfId = payload.selfId;
    const call: ManagedCall = {
      id: payload.callId, roomId: payload.roomId, isGroup: true, selfId: payload.selfId, callerId: payload.callerId,
      participantIds: payload.participantIds, mediaType: payload.mediaType, state: "ringing", pendingCandidates: []
    };
    this.calls.set(call.id, call);
    this.emit("call:incoming", this.snapshot(call));
    this.emit("call:state", this.snapshot(call));
  }

  private onGroupParticipantJoined(payload: GroupCallParticipantEvent): void {
    const call = this.calls.get(payload.callId);
    if (!call?.isGroup || call.state === "ended") return;
    this.selfId = payload.selfId;
    call.selfId = payload.selfId;
    call.participantIds = payload.participantIds;
    if (payload.participantId !== payload.selfId && call.localStream) this.groupConnection(call, payload.participantId);
    this.emit("call:state", this.snapshot(call));
    this.emit("group:call:participant-joined", this.snapshot(call), payload.participantId);
  }

  private onGroupParticipantLeft(payload: GroupCallParticipantEvent): void {
    const call = this.calls.get(payload.callId);
    if (!call?.isGroup || call.state === "ended") return;
    this.selfId = payload.selfId;
    call.selfId = payload.selfId;
    call.participantIds = payload.participantIds;
    this.closeGroupPeer(call, payload.participantId);
    this.emit("call:state", this.snapshot(call));
    this.emit("group:call:participant-left", this.snapshot(call), payload.participantId);
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
    // A rejected one-to-one call ends. A rejected group invite only removes that
    // invitee; the call continues for the remaining members.
    if (!call.isGroup) this.releaseCall(call, true, { callId: call.id, roomId: call.roomId, endedById: payload.recipientId, reason: "rejected" });
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

  private async onGroupOffer(payload: GroupWebRtcDescriptionEvent): Promise<void> {
    const call = this.calls.get(payload.callId);
    if (!call?.isGroup || call.state === "ended") return;
    try {
      const connection = this.groupConnection(call, payload.senderId);
      await connection.setRemoteDescription(payload.description);
      await this.flushPeerCandidates(call, payload.senderId);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      await this.sendGroupAnswer(call.id, payload.senderId, this.description(connection.localDescription));
    } catch (reason) { this.emit("error", reason instanceof Error ? reason : new Error("Unable to answer the WebRTC offer.")); }
  }

  private async onGroupAnswer(payload: GroupWebRtcDescriptionEvent): Promise<void> {
    const call = this.calls.get(payload.callId);
    const connection = call?.connections?.get(payload.senderId);
    if (!call?.isGroup || !connection) return;
    try { await connection.setRemoteDescription(payload.description); await this.flushPeerCandidates(call, payload.senderId); }
    catch (reason) { this.emit("error", reason instanceof Error ? reason : new Error("Unable to apply the WebRTC answer.")); }
  }

  private async onGroupIceCandidate(payload: GroupWebRtcIceCandidateEvent): Promise<void> {
    const call = this.calls.get(payload.callId);
    const connection = call?.connections?.get(payload.senderId);
    if (!call?.isGroup || !connection) return;
    if (!connection.remoteDescription) {
      if (!call.pendingByPeer) call.pendingByPeer = new Map();
      const pending = call.pendingByPeer.get(payload.senderId) ?? [];
      pending.push(payload.candidate);
      call.pendingByPeer.set(payload.senderId, pending);
      return;
    }
    try { await connection.addIceCandidate(payload.candidate); }
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

  private groupConnection(call: ManagedCall, peerId: string): RTCPeerConnection {
    const existing = call.connections?.get(peerId);
    if (existing) return existing;
    if (typeof RTCPeerConnection === "undefined") throw new Error("WebRTC is only available in a browser runtime.");
    if (!call.connections) call.connections = new Map();
    if (!call.pendingByPeer) call.pendingByPeer = new Map();
    const connection = new RTCPeerConnection({ iceServers: this.options.iceServers });
    call.connections.set(peerId, connection);
    for (const track of call.localStream?.getTracks() ?? []) connection.addTrack(track, call.localStream!);
    connection.onicecandidate = (event) => {
      if (event.candidate) void this.sendGroupIceCandidate(call.id, peerId, this.candidate(event.candidate)).catch((reason) => this.emit("error", reason instanceof Error ? reason : new Error("Unable to send an ICE candidate.")));
    };
    connection.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      call.remoteStreams = { ...(call.remoteStreams ?? {}), [peerId]: stream };
      this.setCallState(call, "active");
      this.emit("call:state", this.snapshot(call));
      this.emit("call:stream", this.snapshot(call), stream, peerId);
    };
    connection.onconnectionstatechange = () => {
      if (connection.connectionState === "failed" || connection.connectionState === "closed") {
        this.emit("error", new Error(`Media connection with ${peerId} was lost.`));
        this.closeGroupPeer(call, peerId);
      }
    };
    return connection;
  }

  private closeGroupPeer(call: ManagedCall, peerId: string): void {
    const connection = call.connections?.get(peerId);
    if (!connection) return;
    call.connections?.delete(peerId);
    call.pendingByPeer?.delete(peerId);
    connection.onconnectionstatechange = null;
    connection.close();
    if (call.remoteStreams) delete call.remoteStreams[peerId];
    this.emit("call:state", this.snapshot(call));
  }

  private async flushPeerCandidates(call: ManagedCall, peerId: string): Promise<void> {
    const connection = call.connections?.get(peerId);
    if (!connection) return;
    const pending = call.pendingByPeer?.get(peerId) ?? [];
    while (pending.length) await connection.addIceCandidate(pending.shift()!);
  }

  private async renegotiatePeer(call: ManagedCall, peerId: string, connection: RTCPeerConnection): Promise<void> {
    if (connection.signalingState !== "stable") throw new Error("A peer connection is busy negotiating. Try screen sharing again in a moment.");
    const offer = await connection.createOffer();
    await connection.setLocalDescription(offer);
    await this.sendGroupOffer(call.id, peerId, this.description(connection.localDescription));
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
    for (const connection of call.connections?.values() ?? []) {
      connection.onconnectionstatechange = null;
      connection.close();
    }
    call.connections?.clear();
    call.pendingByPeer?.clear();
    call.remoteStreams = undefined;
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
    return {
      id: call.id, roomId: call.roomId, isGroup: call.isGroup, remoteUserId: call.remoteUserId, callerId: call.callerId,
      participantIds: call.participantIds, mediaType: call.mediaType, state: call.state, localStream: call.localStream,
      remoteStream: call.remoteStream, remoteStreams: call.remoteStreams, isScreenSharing: Boolean(call.screenStream)
    };
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
