import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RealtimeProvider } from "@realtime/react";
import { Chat } from "./Chat";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const userId = params.get("user") || `user-${crypto.randomUUID().slice(0, 8)}`;

// Give each test tab its own visible identity when one was not supplied.
// Explicit URLs such as `?user=alice` remain stable across reloads.
if (!params.has("user")) {
  params.set("user", userId);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RealtimeProvider url="http://localhost:3001" options={{ query: { userId } }}>
      <Chat userId={userId} />
    </RealtimeProvider>
  </StrictMode>
);
