import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useCall, useChat, useRealtime } from "@realtime/react";

type DeliveryEvent = { messageId: string; recipientId: string };
type DeliveryState = Record<string, DeliveryEvent[]>;
type CallSignal = { type: "invite" | "ready"; from: string; to: string; roomId: string; mediaType?: "audio" | "video" };

const CALL_SIGNAL_PREFIX = "__realtime_v03_call_test__:";
const directRoomId = (firstUserId: string, secondUserId: string) => `dm:${[firstUserId, secondUserId].sort().join(":")}`;
const callSignal = (signal: CallSignal) => `${CALL_SIGNAL_PREFIX}${JSON.stringify(signal)}`;
const parseCallSignal = (content: string): CallSignal | null => {
  if (!content.startsWith(CALL_SIGNAL_PREFIX)) return null;
  try {
    const value = JSON.parse(content.slice(CALL_SIGNAL_PREFIX.length)) as Partial<CallSignal>;
    return (value.type === "invite" || value.type === "ready") && typeof value.from === "string" && typeof value.to === "string" && typeof value.roomId === "string" && (value.mediaType === undefined || value.mediaType === "audio" || value.mediaType === "video") ? value as CallSignal : null;
  } catch { return null; }
};

function CallAudio({ stream }: { stream?: MediaStream }) {
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (audio.current) audio.current.srcObject = stream ?? null; }, [stream]);
  return <audio ref={audio} autoPlay controls aria-label="Remote caller audio" />;
}

function CallVideo({ stream, muted = false }: { stream?: MediaStream; muted?: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) video.current.srcObject = stream ?? null; }, [stream]);
  return <video ref={video} autoPlay playsInline muted={muted} controls aria-label={muted ? "Local caller video" : "Remote caller video"} />;
}

export function Chat({ userId, initialCallWith }: { userId: string; initialCallWith?: string }) {
  const realtime = useRealtime();
  const { messages, userIds, typingUserIds, error: chatError, sendMessage, setTyping } = useChat("lobby");
  const { calls, error: callError, startAudioCall, startVideoCall, answerAudioCall, answerVideoCall, startScreenShare, stopScreenShare, rejectCall, hangupCall } = useCall();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [targetUserId, setTargetUserId] = useState(initialCallWith ?? "");
  const [callStatus, setCallStatus] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryState>({});
  const typingTimeout = useRef<number | undefined>(undefined);
  const callTimeout = useRef<number | undefined>(undefined);
  const pendingCall = useRef<{ targetUserId: string; roomId: string } | null>(null);
  const handledSignals = useRef(new Set<string>());
  const requestedRoomId = useMemo(() => {
    const target = targetUserId.trim();
    return target && target !== userId ? directRoomId(userId, target) : null;
  }, [targetUserId, userId]);

  useEffect(() => () => {
    if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
    if (callTimeout.current) window.clearTimeout(callTimeout.current);
  }, []);
  useEffect(() => realtime.on("message:delivered", (event) => {
    setDeliveries((current) => ({ ...current, [event.messageId]: [...(current[event.messageId] ?? []), event] }));
  }), [realtime]);
  useEffect(() => {
    for (const message of messages) {
      const signal = parseCallSignal(message.content);
      if (!signal || handledSignals.current.has(message.id)) continue;
      handledSignals.current.add(message.id);
      if (signal.type === "invite" && signal.to === userId) {
        void (async () => {
          try {
            await realtime.joinRoom(signal.roomId);
            await sendMessage(callSignal({ type: "ready", from: userId, to: signal.from, roomId: signal.roomId, mediaType: signal.mediaType }));
            setCallStatus(`Ready to receive ${signal.from}'s call.`);
          } catch (reason) {
            setCallStatus(reason instanceof Error ? reason.message : "Unable to prepare the incoming call.");
          }
        })();
      }
      if (signal.type === "ready" && signal.to === userId && pendingCall.current?.targetUserId === signal.from && pendingCall.current.roomId === signal.roomId) {
        pendingCall.current = null;
        if (callTimeout.current) window.clearTimeout(callTimeout.current);
        setCallStatus(`Calling ${signal.from}...`);
        const start = signal.mediaType === "video" ? startVideoCall : startAudioCall;
        void start(signal.roomId).then(() => setCallStatus(`Ringing ${signal.from}...`)).catch(() => setCallStatus(null));
      }
    }
  }, [messages, realtime, sendMessage, startAudioCall, startVideoCall, userId]);

  const updateText = (next: string) => {
    setText(next);
    if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
    if (!next.trim()) { void setTyping(false); return; }
    void setTyping(true);
    typingTimeout.current = window.setTimeout(() => void setTyping(false), 1_200);
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(text); setText("");
      if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
      await setTyping(false);
    } finally { setSending(false); }
  };
  const beginCall = async (mediaType: "audio" | "video") => {
    const target = targetUserId.trim();
    if (!requestedRoomId) { setCallStatus("Enter another user's ID first."); return; }
    setCallStatus(`Contacting ${target}...`);
    try {
      await realtime.joinRoom(requestedRoomId);
      pendingCall.current = { targetUserId: target, roomId: requestedRoomId };
      await sendMessage(callSignal({ type: "invite", from: userId, to: target, roomId: requestedRoomId, mediaType }));
      if (callTimeout.current) window.clearTimeout(callTimeout.current);
      callTimeout.current = window.setTimeout(() => {
        if (pendingCall.current?.roomId === requestedRoomId) {
          pendingCall.current = null;
          setCallStatus(`${target} did not respond. Make sure they are connected to the lobby.`);
        }
      }, 15_000);
    } catch (reason) { setCallStatus(reason instanceof Error ? reason.message : "Unable to start the call."); }
  };
  const runCallAction = (action: () => Promise<unknown>) => void action().catch(() => undefined);
  const visibleMessages = messages.filter((message) => !parseCallSignal(message.content));

  return <main>
    <p className="eyebrow">Realtime Platform · v0.4 browser test</p>
    <h1>Realtime test console</h1>
    <p>Signed in locally as <strong>{userId}</strong> · {realtime.connected ? "connected" : "connecting..."} · {userIds.length} user{userIds.length === 1 ? "" : "s"} in the lobby</p>
    <p className="presence">Lobby presence: {userIds.length ? userIds.join(", ") : "waiting for room presence..."}</p>
    {chatError && <p className="error">Chat: {chatError.message}</p>}
    <section aria-label="Lobby messages">
      <h2>Lobby chat</h2>
      {visibleMessages.length === 0 ? <p className="empty">Open another tab with a different user ID, then send a message.</p> : visibleMessages.map((message) => {
        const deliveredTo = deliveries[message.id] ?? [];
        return <article key={message.id}><strong>{message.senderId}</strong><span>{message.content}</span>{message.senderId === userId && <small>{deliveredTo.length ? `Delivered to ${deliveredTo.map((event) => event.recipientId).join(", ")}` : "Waiting for delivery..."}</small>}</article>;
      })}
    </section>
    {typingUserIds.length > 0 && <p className="typing">{typingUserIds.join(", ")} {typingUserIds.length === 1 ? "is" : "are"} typing...</p>}
    <form onSubmit={(event) => void submit(event)}><input value={text} onChange={(event) => updateText(event.target.value)} placeholder="Write a lobby message" aria-label="Message" /><button disabled={sending || !text.trim()}>{sending ? "Sending..." : "Send"}</button></form>
    <section className="call-panel" aria-label="Call test">
      <h2>One-to-one audio and video calls</h2>
      <p className="empty">Enter a connected user’s ID and call them. The receiver is prepared automatically, then sees a real incoming call with Answer and Reject controls.</p>
      <div className="call-controls"><input value={targetUserId} onChange={(event) => setTargetUserId(event.target.value)} placeholder="User ID to call (for example, bob)" aria-label="User ID to call" /><button type="button" onClick={() => void beginCall("audio")} disabled={!realtime.connected || !!pendingCall.current}>Audio call</button><button type="button" onClick={() => void beginCall("video")} disabled={!realtime.connected || !!pendingCall.current}>Video call</button></div>
      {requestedRoomId && <p className="room-id">Private call room: <code>{requestedRoomId}</code></p>}
      {callStatus && <p className="presence">{callStatus}</p>}
      {callError && <p className="error">Call: {callError.message}</p>}
      {calls.length === 0 ? <p className="empty">No active or ringing calls.</p> : calls.map((call) => <article className="call" key={call.id}>
        <strong>{call.state === "ringing" ? `Incoming or outgoing ${call.mediaType} call with ${call.remoteUserId}` : `${call.mediaType} call with ${call.remoteUserId}: ${call.state}`}</strong><small>Room: {call.roomId}</small>
        {call.mediaType === "video" && call.localStream && <CallVideo stream={call.localStream} muted />}
        {call.remoteStream && call.remoteStream.getVideoTracks().length > 0 && <CallVideo stream={call.remoteStream} />}
        {call.remoteStream && <CallAudio stream={call.remoteStream} />}
        <div className="call-actions">{call.state === "ringing" && !call.localStream && <><button type="button" onClick={() => runCallAction(() => call.mediaType === "video" ? answerVideoCall(call.id) : answerAudioCall(call.id))}>Answer</button><button className="secondary" type="button" onClick={() => runCallAction(() => rejectCall(call.id))}>Reject</button></>}{call.state === "active" && <button type="button" onClick={() => runCallAction(() => call.isScreenSharing ? stopScreenShare(call.id) : startScreenShare(call.id))}>{call.isScreenSharing ? "Stop sharing" : "Share screen"}</button>}<button className="danger" type="button" onClick={() => runCallAction(() => hangupCall(call.id))}>Hang up</button></div>
      </article>)}
    </section>
  </main>;
}
