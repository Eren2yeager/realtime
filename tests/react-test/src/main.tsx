import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RealtimeProvider } from "@realtime/react";
import type { IceServer } from "@realtime/core";
import { Chat } from "./Chat";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const userId = params.get("user") || `user-${crypto.randomUUID().slice(0, 8)}`;
const initialCallWith = params.get("callWith") || undefined;

// Give each test tab its own visible identity when one was not supplied.
// Explicit URLs such as `?user=alice` remain stable across reloads.
if (!params.has("user")) {
  params.set("user", userId);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
}

const root = createRoot(document.getElementById("root")!);

async function loadIceServers(): Promise<IceServer[]> {
  const endpoint = import.meta.env.VITE_METERED_ICE_SERVERS_URL;
  if (!endpoint) return [];
  const response = await fetch(endpoint);
  if (!response.ok) throw new Error(`Unable to load Metered ICE servers (${response.status}).`);
  return response.json() as Promise<IceServer[]>;
}

try {
  const iceServers = await loadIceServers();
  console.log(iceServers)
  root.render(
    <StrictMode>
      <RealtimeProvider url="http://localhost:3000" options={{ query: { userId }, iceServers }}>
        <Chat userId={userId} initialCallWith={initialCallWith} />
      </RealtimeProvider>
    </StrictMode>
  );
} catch (reason) {
  const message = reason instanceof Error ? reason.message : "Unable to load Metered ICE servers.";
  root.render(<main><p className="error">{message}</p></main>);
}
