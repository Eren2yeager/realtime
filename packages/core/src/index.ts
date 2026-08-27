export const PROTOCOL_VERSION = "0.2";

export type Metadata = Record<string, unknown>;

export type AuthenticatedUser = {
  userId: string;
  metadata?: Metadata;
};

export type RoomAction = "join" | "send-message" | "typing";

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

export type RealtimeErrorCode =
  | "AUTHENTICATION_FAILED"
  | "UNAUTHORIZED"
  | "INVALID_PAYLOAD"
  | "NOT_IN_ROOM"
  | "PROTOCOL_MISMATCH"
  | "INTERNAL_ERROR";

export type RealtimeError = { code: RealtimeErrorCode; message: string };
export type Result<T> = { ok: true; data: T } | { ok: false; error: RealtimeError };

export type ClientToServerEvents = {
  "protocol:handshake": (version: string, ack: (result: Result<{ version: string }>) => void) => void;
  "room:join": (input: JoinRoomInput, ack: (result: Result<{ roomId: string }>) => void) => void;
  "room:leave": (input: JoinRoomInput, ack: (result: Result<{ roomId: string }>) => void) => void;
  "message:send": (input: SendMessageInput, ack: (result: Result<RealtimeMessage>) => void) => void;
  "typing:set": (input: TypingInput, ack: (result: Result<{ roomId: string; isTyping: boolean }>) => void) => void;
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
  error: (error: RealtimeError) => void;
};

export const directRoomId = (firstUserId: string, secondUserId: string): string => {
  if (!firstUserId || !secondUserId) throw new Error("Both user IDs are required.");
  return `dm:${[firstUserId, secondUserId].sort().join(":")}`;
};

export const errorResult = (code: RealtimeErrorCode, message: string): Result<never> => ({
  ok: false,
  error: { code, message }
});
