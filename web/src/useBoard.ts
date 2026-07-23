import { ref, shallowRef } from "vue";
import { isFlashing, projectName } from "./format";
import type { Aircraft, WsMessage } from "./types";

/** how long a strip must stay in holding before we notify. 0 = fire immediately.
 *  (A larger value would suppress the session you're actively replying to.) */
const HOLD_NOTIFY_DELAY = 0;

/**
 * Live board state over the backend WebSocket, with auto-reconnect. The server is the
 * source of truth (including notes); we just render what it pushes.
 */
export function useBoard() {
  const aircraft = shallowRef<Aircraft[]>([]);
  const connected = ref(false);
  const now = ref(Date.now());

  const notifySupported = typeof Notification !== "undefined";
  const notifyEnabled = ref(false);

  let ws: WebSocket | null = null;
  let retry = 0;

  // --- holding notifications ---------------------------------------------------------
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const notified = new Set<string>();
  let primed = false; // false => next update baselines (existing holding won't ping)

  function fire(a: Aircraft) {
    if (!notifySupported || Notification.permission !== "granted") return;
    const n = new Notification(`Needs you — ${a.title || a.id}`, {
      body: [projectName(a.project), a.lastEventSummary].filter(Boolean).join(" · "),
      tag: a.id, // same session replaces rather than stacks
      icon: "/notify-icon.png",
    });
    n.onclick = () => {
      window.focus();
      open(a.id);
      n.close();
    };
  }

  function reconcileNotifications(list: Aircraft[]) {
    if (!notifyEnabled.value) return;
    // first update after enabling: baseline everything currently holding as
    // already-handled so we don't ping for sessions that were waiting before you opted in.
    if (!primed) {
      notified.clear();
      for (const a of list) if (isFlashing(a)) notified.add(a.id);
      primed = true;
      return;
    }
    const holding = new Set(list.filter(isFlashing).map((a) => a.id));
    // a session that left holding (you replied / parked it) clears its timer + memory,
    // so the next time it comes back to you it can notify again.
    for (const [id, t] of pending) if (!holding.has(id)) (clearTimeout(t), pending.delete(id));
    for (const id of [...notified]) if (!holding.has(id)) notified.delete(id);
    // newly holding → notify once it has settled for HOLD_NOTIFY_DELAY
    for (const id of holding) {
      if (pending.has(id) || notified.has(id)) continue;
      pending.set(
        id,
        setTimeout(() => {
          pending.delete(id);
          const cur = aircraft.value.find((x) => x.id === id);
          if (cur && isFlashing(cur)) {
            fire(cur);
            notified.add(id);
          }
        }, HOLD_NOTIFY_DELAY),
      );
    }
  }

  async function toggleNotify() {
    if (!notifySupported) return;
    if (notifyEnabled.value) {
      notifyEnabled.value = false;
      pending.forEach(clearTimeout);
      pending.clear();
      notified.clear();
      primed = false;
      localStorage.setItem("fc-notify", "0");
      return;
    }
    let perm = Notification.permission;
    if (perm === "default") perm = await Notification.requestPermission();
    if (perm !== "granted") return;
    primed = false; // next update baselines current holding, then notifies on new entries
    notifyEnabled.value = true;
    localStorage.setItem("fc-notify", "1");
    reconcileNotifications(aircraft.value); // baseline immediately against what's on screen
  }

  // -----------------------------------------------------------------------------------

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
        reconcileNotifications(msg.aircraft);
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
    if (notifySupported && Notification.permission === "granted" && localStorage.getItem("fc-notify") === "1") {
      notifyEnabled.value = true; // first snapshot baselines via the `primed` guard
    }
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

  async function land(id: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/landed`, { method: "POST" });
  }

  async function unland(id: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/landed`, { method: "DELETE" });
  }

  async function open(id: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/open`, { method: "POST" });
  }

  async function goAround(id: string) {
    await fetch(`/api/aircraft/${encodeURIComponent(id)}/go-around`, { method: "POST" });
  }

  return { aircraft, connected, now, start, setNote, removeNote, land, unland, open, goAround, notifySupported, notifyEnabled, toggleNotify };
}
