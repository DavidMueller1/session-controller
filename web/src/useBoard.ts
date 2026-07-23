import { ref, shallowRef } from "vue";
import type { Aircraft, WsMessage } from "./types";

/**
 * Live board state over the backend WebSocket, with auto-reconnect. The server is the
 * source of truth (including notes); we just render what it pushes.
 */
export function useBoard() {
  const aircraft = shallowRef<Aircraft[]>([]);
  const connected = ref(false);
  const now = ref(Date.now());

  let ws: WebSocket | null = null;
  let retry = 0;

  function wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${location.host}/ws`;
  }

  function connect() {
    ws = new WebSocket(wsUrl());
    ws.onopen = () => {
      connected.value = true;
      retry = 0;
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data) as WsMessage;
      if (msg.type === "snapshot" || msg.type === "update") {
        aircraft.value = msg.aircraft;
      }
    };
    ws.onclose = () => {
      connected.value = false;
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 500 * retry);
    };
    ws.onerror = () => ws?.close();
  }

  function start() {
    connect();
    setInterval(() => (now.value = Date.now()), 1000);
  }

  async function setNote(id: string, note: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/note`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    });
  }

  async function removeNote(id: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/note`, { method: "DELETE" });
  }

  return { aircraft, connected, now, start, setNote, removeNote };
}
