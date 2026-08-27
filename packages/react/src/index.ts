import { createContext, createElement, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { RealtimeClient, type RealtimeCall, type RealtimeClientOptions } from "@realtime/client";
import type { RealtimeMessage } from "@realtime/core";

const ClientContext = createContext<RealtimeClient | null>(null);

export function RealtimeProvider({ url, options, children }: { url: string; options?: RealtimeClientOptions; children: ReactNode }) {
  const client = useMemo(() => new RealtimeClient(url, options), [url]);
  useEffect(() => { client.connect(); return () => client.destroy(); }, [client]);
  return createElement(ClientContext.Provider, { value: client }, children);
}

export function useRealtime(): RealtimeClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("useRealtime must be used within RealtimeProvider.");
  return client;
}

export function useChat(roomId: string) {
  const client = useRealtime();
  const [messages, setMessages] = useState<RealtimeMessage[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [typingUserIds, setTypingUserIds] = useState<string[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    let active = true;
    void client.joinRoom(roomId).catch((reason) => active && setError(reason instanceof Error ? reason : new Error("Unable to join room.")));
    const unsubscribeMessage = client.on("message", (message) => { if (message.roomId === roomId) setMessages((current) => [...current, message]); });
    const unsubscribePresence = client.on("presence:state", (presence) => { if (presence.roomId === roomId) setUserIds(presence.userIds); });
    const unsubscribeOnline = client.on("user:online", (presence) => { if (presence.roomId === roomId) setUserIds((current) => current.includes(presence.userId) ? current : [...current, presence.userId]); });
    const unsubscribeOffline = client.on("user:offline", (presence) => { if (presence.roomId === roomId) { setUserIds((current) => current.filter((userId) => userId !== presence.userId)); setTypingUserIds((current) => current.filter((userId) => userId !== presence.userId)); } });
    const unsubscribeTypingStart = client.on("typing:start", (typing) => { if (typing.roomId === roomId) setTypingUserIds((current) => current.includes(typing.userId) ? current : [...current, typing.userId]); });
    const unsubscribeTypingStop = client.on("typing:stop", (typing) => { if (typing.roomId === roomId) setTypingUserIds((current) => current.filter((userId) => userId !== typing.userId)); });
    return () => {
      active = false;
      unsubscribeMessage(); unsubscribePresence(); unsubscribeOnline(); unsubscribeOffline(); unsubscribeTypingStart(); unsubscribeTypingStop();
      void client.setTyping(roomId, false).catch(() => undefined);
      void client.leaveRoom(roomId);
    };
  }, [client, roomId]);
  return {
    messages,
    userIds,
    typingUserIds,
    error,
    sendMessage: (content: string, clientMessageId?: string) => client.sendMessage(roomId, content, clientMessageId),
    setTyping: (isTyping: boolean) => client.setTyping(roomId, isTyping)
  };
}

/** React binding for browser audio/video calls and display sharing. */
export function useCall() {
  const client = useRealtime();
  const [calls, setCalls] = useState<RealtimeCall[]>([]);
  const [error, setError] = useState<Error | null>(null);
  useEffect(() => {
    const record = (call: RealtimeCall) => setCalls((current) => call.state === "ended"
      ? current.filter((item) => item.id !== call.id)
      : [...current.filter((item) => item.id !== call.id), call]);
    const remove = (call: RealtimeCall) => setCalls((current) => current.filter((item) => item.id !== call.id));
    const unsubscribeIncoming = client.on("call:incoming", record);
    const unsubscribeAccepted = client.on("call:accepted", record);
    const unsubscribeState = client.on("call:state", record);
    const unsubscribeEnded = client.on("call:ended", remove);
    return () => { unsubscribeIncoming(); unsubscribeAccepted(); unsubscribeState(); unsubscribeEnded(); };
  }, [client]);
  const capture = async <T,>(operation: () => Promise<T>): Promise<T> => {
    try { setError(null); return await operation(); }
    catch (reason) {
      const next = reason instanceof Error ? reason : new Error("Call operation failed.");
      setError(next);
      throw next;
    }
  };
  return {
    calls,
    error,
    startAudioCall: (roomId: string) => capture(() => client.startAudioCall(roomId)),
    startVideoCall: (roomId: string) => capture(() => client.startVideoCall(roomId)),
    answerAudioCall: (callId: string) => capture(() => client.answerAudioCall(callId)),
    answerVideoCall: (callId: string) => capture(() => client.answerVideoCall(callId)),
    startScreenShare: (callId: string) => capture(() => client.startScreenShare(callId)),
    stopScreenShare: (callId: string) => capture(() => client.stopScreenShare(callId)),
    rejectCall: (callId: string) => capture(() => client.rejectCall(callId)),
    hangupCall: (callId: string) => capture(() => client.hangupCall(callId))
  };
}
