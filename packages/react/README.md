# @realtimesdk/react

[![npm version](https://img.shields.io/npm/v/@realtimesdk/react.svg)](https://www.npmjs.com/package/@realtimesdk/react)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

Thin React bindings over the [`@realtimesdk/client`](../client) browser SDK. Provides a `RealtimeProvider`, the `useRealtime` client hook, and convenience hooks for chat and calling state.

## Install

```bash
npm install @realtimesdk/react @realtimesdk/client react
```

`react` (>= 18) is a peer dependency.

## Usage

```tsx
import { RealtimeProvider, useChat, useCall } from "@realtimesdk/react";

function Chat() {
  const { messages, sendMessage } = useChat("lobby");
  return <button onClick={() => void sendMessage("Hello!")}>{messages.length}</button>;
}

function Calls() {
  const { calls, startAudioCall, hangupCall } = useCall();
  return <button onClick={() => startAudioCall("private:alice:bob")}>Call</button>;
}

export function App() {
  return (
    <RealtimeProvider url="http://localhost:3001" options={{ auth: { token: "app-token" } }}>
      <Chat />
      <Calls />
    </RealtimeProvider>
  );
}
```

## License

[MIT](../../LICENSE)
