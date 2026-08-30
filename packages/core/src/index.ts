export const PROTOCOL_VERSION = "0.7";

export type Metadata = Record<string, unknown>;

export type AuthenticatedUser = {
  userId: string;
  metadata?: Metadata;
};

export type RoomAction = "join" | "send-message" | "typing" | "call" | "webrtc" | "sfu";

export type JoinRoomInput = { roomId: string };
export type SendMessageInput = { roomId: string; content: string; clientMessageId?: string };
export type RealtimeMessage = {
  id: string;
  roomId: string;
  senderId: string;
  content: string;
  clientMessageId?: string;
  sentAt: string;
};

export type PresenceState = { roomId: string; userIds: string[] };
export type RoomPresenceEvent = { roomId: string; userId: string };
export type TypingInput = { roomId: string; isTyping: boolean };
export type TypingEvent = { roomId: string; userId: string };
export type MessageDeliveredEvent = {
  messageId: string;
  roomId: string;
  recipientId: string;
  deliveredAt: string;
};

export type IceServer = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type CallMediaType = "audio" | "video";
export type CallStartInput = { roomId: string; mediaType?: CallMediaType };
export type CallResponseInput = { callId: string };
export type CallHangupInput = { callId: string };
export type CallIncomingEvent = { callId: string; roomId: string; callerId: string; mediaType: CallMediaType };
export type CallAcceptedEvent = { callId: string; roomId: string; recipientId: string; mediaType: CallMediaType };
export type CallRejectedEvent = { callId: string; roomId: string; recipientId: string };
export type CallEndReason = "hangup" | "rejected" | "timeout" | "disconnected" | "room-left";
export type CallEndedEvent = { callId: string; roomId: string; endedById?: string; reason: CallEndReason };

export type SfuMediaMode = "mesh" | "sfu";
export type GroupCallStartInput = { roomId: string; mediaType?: CallMediaType };
export type GroupCallResult = {
  callId: string;
  roomId: string;
  participantIds: string[];
  selfId: string;
  mediaMode: SfuMediaMode;
};
export type GroupCallJoinResult = { callId: string; participantIds: string[]; selfId: string; mediaMode: SfuMediaMode };
export type GroupCallIncomingEvent = {
  callId: string;
  roomId: string;
  callerId: string;
  mediaType: CallMediaType;
  participantIds: string[];
  selfId: string;
  mediaMode: SfuMediaMode;
};
export type GroupCallParticipantEvent = {
  callId: string;
  roomId: string;
  participantId: string;
  participantIds: string[];
  selfId: string;
};

export type WebRtcSessionDescription = { type: "offer" | "answer"; sdp: string };
export type WebRtcIceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};
export type WebRtcDescriptionInput = { callId: string; description: WebRtcSessionDescription };
export type WebRtcIceCandidateInput = { callId: string; candidate: WebRtcIceCandidate };
export type WebRtcDescriptionEvent = {
  callId: string;
  roomId: string;
  senderId: string;
  description: WebRtcSessionDescription;
};
export type WebRtcIceCandidateEvent = {
  callId: string;
  roomId: string;
  senderId: string;
  candidate: WebRtcIceCandidate;
};
export type GroupWebRtcDescriptionInput = { callId: string; targetId: string; description: WebRtcSessionDescription };
export type GroupWebRtcIceCandidateInput = { callId: string; targetId: string; candidate: WebRtcIceCandidate };
export type GroupWebRtcDescriptionEvent = {
  callId: string;
  roomId: string;
  senderId: string;
  targetId: string;
  description: WebRtcSessionDescription;
};
export type GroupWebRtcIceCandidateEvent = {
  callId: string;
  roomId: string;
  senderId: string;
  targetId: string;
  candidate: WebRtcIceCandidate;
};

/** mediasoup-compatible WebRTC transport parameters, relayed by the realtime server. */
export type SfuIceParameters = {
  usernameFragment: string;
  password: string;
  iceLite?: boolean;
};
export type SfuIceCandidate = {
  foundation: string;
  protocol: "udp" | "tcp";
  ip: string;
  address: string;
  port: number;
  type: "host" | "srflx" | "prflx" | "relay";
  priority: number;
  tcpType?: "passive";
};
export type SfuDtlsParameters = {
  role?: "auto" | "client" | "server";
  fingerprints: { algorithm: "sha-1" | "sha-224" | "sha-256" | "sha-384" | "sha-512"; value: string }[];
};
/** Opaque to the protocol layer; the SFU and client interpret these as mediasoup RTP types. */
export type SfuRtpCapabilities = Record<string, unknown>;
export type SfuRtpParameters = Record<string, unknown>;

export type SfuCallInput = { callId: string };
export type SfuRtpCapabilitiesInput = { callId: string };
export type SfuRtpCapabilitiesResult = { rtpCapabilities: SfuRtpCapabilities };
export type SfuTransportDirection = "send" | "recv";
export type SfuCreateTransportInput = {
  callId: string;
  direction: SfuTransportDirection;
  appData?: Record<string, unknown>;
};
export type SfuCreatedTransport = {
  transportId: string;
  iceParameters: SfuIceParameters;
  iceCandidates: SfuIceCandidate[];
  dtlsParameters: SfuDtlsParameters;
};
export type SfuConnectTransportInput = { callId: string; transportId: string; dtlsParameters: SfuDtlsParameters };
export type SfuProduceInput = {
  callId: string;
  transportId: string;
  kind: "audio" | "video";
  rtpParameters: SfuRtpParameters;
  appData?: Record<string, unknown>;
};
export type SfuProducerResult = { producerId: string; kind: "audio" | "video" };
export type SfuConsumeInput = {
  callId: string;
  transportId: string;
  producerId: string;
  rtpCapabilities: SfuRtpCapabilities;
};
export type SfuConsumerResult = {
  consumerId: string;
  producerId: string;
  kind: "audio" | "video";
  rtpParameters: SfuRtpParameters;
  paused: boolean;
};
export type SfuResumeConsumerInput = { callId: string; consumerId: string };
export type SfuCloseTransportInput = { callId: string; transportId: string };
export type SfuCloseProducerInput = { callId: string; producerId: string };
export type SfuCloseConsumerInput = { callId: string; consumerId: string };

export type SfuProducerAddedEvent = {
  callId: string;
  roomId: string;
  producerId: string;
  peerId: string;
  kind: "audio" | "video";
  appData?: Record<string, unknown>;
};
export type SfuProducerRemovedEvent = { callId: string; roomId: string; producerId: string; peerId: string };

export type RealtimeErrorCode =
  | "AUTHENTICATION_FAILED"
  | "UNAUTHORIZED"
  | "INVALID_PAYLOAD"
  | "NOT_IN_ROOM"
  | "CALL_NOT_FOUND"
  | "CALL_INVALID_STATE"
  | "CALL_UNAVAILABLE"
  | "SFU_UNAVAILABLE"
  | "SFU_ERROR"
  | "PROTOCOL_MISMATCH"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export type RealtimeError = { code: RealtimeErrorCode; message: string };
export type Result<T> = { ok: true; data: T } | { ok: false; error: RealtimeError };

export type ClientToServerEvents = {
  "protocol:handshake": (version: string, ack: (result: Result<{ version: string }>) => void) => void;
  "room:join": (input: JoinRoomInput, ack: (result: Result<{ roomId: string }>) => void) => void;
  "room:leave": (input: JoinRoomInput, ack: (result: Result<{ roomId: string }>) => void) => void;
  "message:send": (input: SendMessageInput, ack: (result: Result<RealtimeMessage>) => void) => void;
  "typing:set": (input: TypingInput, ack: (result: Result<{ roomId: string; isTyping: boolean }>) => void) => void;
  "call:start": (
    input: CallStartInput,
    ack: (result: Result<{ callId: string; roomId: string; recipientId: string }>) => void,
  ) => void;
  "call:accept": (input: CallResponseInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "call:reject": (input: CallResponseInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "call:hangup": (input: CallHangupInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "call:start-group": (input: GroupCallStartInput, ack: (result: Result<GroupCallResult>) => void) => void;
  "call:join": (input: CallResponseInput, ack: (result: Result<GroupCallJoinResult>) => void) => void;
  "call:leave": (input: CallResponseInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "webrtc:offer": (input: WebRtcDescriptionInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "webrtc:answer": (input: WebRtcDescriptionInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "webrtc:ice-candidate": (input: WebRtcIceCandidateInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "group:webrtc:offer": (input: GroupWebRtcDescriptionInput, ack: (result: Result<{ callId: string }>) => void) => void;
  "group:webrtc:answer": (
    input: GroupWebRtcDescriptionInput,
    ack: (result: Result<{ callId: string }>) => void,
  ) => void;
  "group:webrtc:ice-candidate": (
    input: GroupWebRtcIceCandidateInput,
    ack: (result: Result<{ callId: string }>) => void,
  ) => void;
  "sfu:rtp-capabilities": (
    input: SfuRtpCapabilitiesInput,
    ack: (result: Result<SfuRtpCapabilitiesResult>) => void,
  ) => void;
  "sfu:create-transport": (input: SfuCreateTransportInput, ack: (result: Result<SfuCreatedTransport>) => void) => void;
  "sfu:connect-transport": (
    input: SfuConnectTransportInput,
    ack: (result: Result<{ transportId: string }>) => void,
  ) => void;
  "sfu:produce": (input: SfuProduceInput, ack: (result: Result<SfuProducerResult>) => void) => void;
  "sfu:consume": (input: SfuConsumeInput, ack: (result: Result<SfuConsumerResult>) => void) => void;
  "sfu:resume-consumer": (input: SfuResumeConsumerInput, ack: (result: Result<{ consumerId: string }>) => void) => void;
  "sfu:close-transport": (
    input: SfuCloseTransportInput,
    ack: (result: Result<{ transportId: string }>) => void,
  ) => void;
  "sfu:close-producer": (input: SfuCloseProducerInput, ack: (result: Result<{ producerId: string }>) => void) => void;
  "sfu:close-consumer": (input: SfuCloseConsumerInput, ack: (result: Result<{ consumerId: string }>) => void) => void;
};

export type ServerToClientEvents = {
  "room:joined": (payload: { roomId: string; userId: string }) => void;
  "room:left": (payload: { roomId: string; userId: string }) => void;
  "presence:state": (payload: PresenceState) => void;
  "user:online": (payload: RoomPresenceEvent) => void;
  "user:offline": (payload: RoomPresenceEvent) => void;
  "typing:start": (payload: TypingEvent) => void;
  "typing:stop": (payload: TypingEvent) => void;
  message: (message: RealtimeMessage) => void;
  "message:delivered": (payload: MessageDeliveredEvent) => void;
  "call:incoming": (payload: CallIncomingEvent) => void;
  "call:accepted": (payload: CallAcceptedEvent) => void;
  "call:rejected": (payload: CallRejectedEvent) => void;
  "call:ended": (payload: CallEndedEvent) => void;
  "group:call:incoming": (payload: GroupCallIncomingEvent) => void;
  "group:call:participant-joined": (payload: GroupCallParticipantEvent) => void;
  "group:call:participant-left": (payload: GroupCallParticipantEvent) => void;
  "webrtc:offer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:answer": (payload: WebRtcDescriptionEvent) => void;
  "webrtc:ice-candidate": (payload: WebRtcIceCandidateEvent) => void;
  "group:webrtc:offer": (payload: GroupWebRtcDescriptionEvent) => void;
  "group:webrtc:answer": (payload: GroupWebRtcDescriptionEvent) => void;
  "group:webrtc:ice-candidate": (payload: GroupWebRtcIceCandidateEvent) => void;
  "sfu:producer-added": (payload: SfuProducerAddedEvent) => void;
  "sfu:producer-removed": (payload: SfuProducerRemovedEvent) => void;
  error: (error: RealtimeError) => void;
};

export const directRoomId = (firstUserId: string, secondUserId: string): string => {
  if (!firstUserId || !secondUserId) throw new Error("Both user IDs are required.");
  return `dm:${[firstUserId, secondUserId].sort().join(":")}`;
};

export const errorResult = (code: RealtimeErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message },
});
