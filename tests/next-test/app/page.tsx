"use client"
import { useEffect, useState } from "react";
import { createRealtimeClient } from "@realtimesdk/client";
export default function Home() { const [status, setStatus] = useState("connecting"); const [messages, setMessages] = useState<string[]>([]); useEffect(() => { const client = createRealtimeClient(window.location.origin); client.on("connected", async () => { setStatus("connected"); await client.joinRoom("next-demo"); }); client.on("message", (m) => setMessages((x) => [...x, `${m.senderId}: ${m.content}`])); client.connect(); return () => client.destroy(); }, []); return <main><h1>Next.js realtime adapter test</h1><p>Status: {status}</p><p>Open two tabs to verify realtime transport.</p><ul>{messages.map((m, i) => <li key={i}>{m}</li>)}</ul></main>; }
