import { FormEvent, useEffect, useRef, useState } from "react";
import { useChat, useRealtime } from "@realtime/react";

export function Chat({ userId }: { userId: string }) {
  const realtime = useRealtime();
  const { messages, userIds, typingUserIds, error, sendMessage, setTyping } = useChat("lobby");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const typingTimeout = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
  }, []);

  const updateText = (next: string) => {
    setText(next);
    if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
    if (!next.trim()) {
      void setTyping(false);
      return;
    }
    void setTyping(true);
    typingTimeout.current = window.setTimeout(() => void setTyping(false), 1_200);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || sending) return;
    setSending(true);
    try {
      await sendMessage(text);
      setText("");
      if (typingTimeout.current) window.clearTimeout(typingTimeout.current);
      await setTyping(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <main>
      <p className="eyebrow">Realtime Platform · v0.1 browser test</p>
      <h1>Lobby</h1>
      <p>Signed in locally as <strong>{userId}</strong> · {realtime.connected ? "connected" : "connecting…"} · {userIds.length} user{userIds.length === 1 ? "" : "s"} online</p>
      <p className="presence">Online: {userIds.length ? userIds.join(", ") : "waiting for room presence…"}</p>
      {error && <p className="error">{error.message}</p>}
      <section aria-label="Messages">
        {messages.length === 0 ? <p className="empty">Open a second tab as another user and send a message.</p> : messages.map((message) => (
          <article key={message.id}>
            <strong>{message.senderId}</strong>
            <span>{message.content}</span>
          </article>
        ))}
      </section>
      {typingUserIds.length > 0 && <p className="typing">{typingUserIds.join(", ")} {typingUserIds.length === 1 ? "is" : "are"} typing…</p>}
      <form onSubmit={(event) => void submit(event)}>
        <input value={text} onChange={(event) => updateText(event.target.value)} placeholder="Write a message" aria-label="Message" />
        <button disabled={sending || !text.trim()}>{sending ? "Sending…" : "Send"}</button>
      </form>
    </main>
  );
}
