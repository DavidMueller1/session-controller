<script setup lang="ts">
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, watch } from "vue";
import Strip from "./components/Strip.vue";
import FlightBoard from "./components/FlightBoard.vue";
import Panel from "./components/Panel.vue";
import Overlay from "./components/Overlay.vue";
import FlipCounter from "./components/FlipCounter.vue";
import Settings from "./components/Settings.vue";
import Help from "./components/Help.vue";
import Whatsnew from "./components/Whatsnew.vue";
import { useBoard } from "./useBoard";
import { laneOf, isFlashing } from "./format";
import type { Aircraft } from "./types";

// Compact mode for the menu-bar popover (loaded as /?panel). Renders just the mini-board
// and tells useBoard to stay silent (the full dashboard owns notifications).
const panel = new URLSearchParams(location.search).has("panel");
// Right-edge floating rail (loaded as /?overlay), hosted in a transparent always-on-top
// panel. Also silent — the full dashboard owns notifications.
const overlay = new URLSearchParams(location.search).has("overlay");

const { aircraft, status, health, connected, now, version, currentBuild, update, updating, applyUpdate, start, setNote, removeNote, land, unland, open, openHint, notifySupported, notifyEnabled, toggleNotify } = useBoard({ notify: !panel && !overlay });
onMounted(start);

// Board layout: the flight-layer (one animated coordinate space) is the default; the
// toggle drops to the simple per-lane list. Only an explicit "0" opts out of flight,
// so a fresh visitor (no stored preference) gets the flight board.
const flight = ref(localStorage.getItem("fc-flight") !== "0");
function toggleFlight() {
  flight.value = !flight.value;
  localStorage.setItem("fc-flight", flight.value ? "1" : "0");
}
// transition debug mode (flight layer only) — client-side lane overrides for testing.
// No visible control now that flight is the default board; toggle it with Shift+D (a dev
// affordance that still works on the built dist, unlike an import.meta.env.DEV gate).
const debug = ref(false);
function onKey(e: KeyboardEvent) {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() !== "d") return;
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  debug.value = !debug.value;
}
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

// Debug rewrites each overridden aircraft's STATE (not just its position), so EVERYTHING
// downstream reacts: the header split-flap counters roll, strip colours change, and the
// flight-layer animates the moves. Actions are driven from the FlightBoard's debug bar
// (Step/Shuffle/Reset) or by clicking a strip to cycle it.
type DebugState = "working" | "needs-input" | "error" | "parked" | "approach" | "landed" | "mia" | "wrapped";
const DEBUG_STATES: DebugState[] = ["working", "needs-input", "error", "parked", "approach", "landed", "mia", "wrapped"];
const debugOverride = ref<Record<string, DebugState>>({});
watch(debug, (on) => { if (!on) debugOverride.value = {}; });

function applyDebug(a: Aircraft, ds: DebugState): Aircraft {
  const base = { ...a, landed: false, approach: false, note: null };
  switch (ds) {
    case "working": return { ...base, state: "working" };
    case "needs-input": return { ...base, state: "needs-input" };
    case "error": return { ...base, state: "error" };
    case "parked": return { ...base, state: "needs-input", note: "parked (debug)" };
    case "approach": return { ...base, state: "needs-input", approach: true }; // Needs you + Approach badge
    case "landed": return { ...base, state: "needs-input", landed: true };
    case "mia": return { ...base, state: "idle" };
    case "wrapped": return { ...base, state: "suspected-done" };
  }
}
const effectiveAircraft = computed<Aircraft[]>(() =>
  debug.value ? aircraft.value.map((a) => (debugOverride.value[a.id] ? applyDebug(a, debugOverride.value[a.id]) : a)) : aircraft.value,
);

function onDbgCycle(id: string) {
  const cur = debugOverride.value[id];
  const next = DEBUG_STATES[(cur ? DEBUG_STATES.indexOf(cur) + 1 : 0) % DEBUG_STATES.length];
  debugOverride.value = { ...debugOverride.value, [id]: next };
}
function onDbgStep() {
  const list = effectiveAircraft.value;
  if (!list.length) return;
  const a = list[Math.floor(Math.random() * list.length)];
  const opts = DEBUG_STATES.filter((s) => s !== debugOverride.value[a.id]);
  debugOverride.value = { ...debugOverride.value, [a.id]: opts[Math.floor(Math.random() * opts.length)] };
}
function onDbgShuffle() {
  const o: Record<string, DebugState> = {};
  for (const a of aircraft.value) o[a.id] = DEBUG_STATES[Math.floor(Math.random() * DEBUG_STATES.length)];
  debugOverride.value = o;
}
function onDbgReset() { debugOverride.value = {}; }

// Claude service-status banner (from status.claude.com, pushed over the WS)
const statusColor = (s: string): string =>
  s === "major_outage" ? "var(--red)"
  : s === "partial_outage" ? "#f0883e"
  : s === "degraded_performance" ? "var(--amber)"
  : s === "under_maintenance" ? "var(--blue)"
  : "var(--gray)";
const prettyStatus = (s: string) => s.replace(/_/g, " ");
const showStatus = computed(() => {
  const s = status.value;
  return !!s && (s.components.length > 0 || s.incidents.length > 0 || (!!s.indicator && s.indicator !== "none"));
});
const statusSev = computed(() => {
  const i = status.value?.indicator;
  return i === "critical" || i === "major" ? "major" : i === "minor" ? "minor" : "info";
});

// Hooks-health banner — only surfaces when the tracking pipeline is degraded/down, so a
// silent regression (e.g. a Claude update rewrites settings.json) becomes visible.
const showHealth = computed(() => !!health.value && health.value.status !== "healthy");
const healthSev = computed(() => (health.value?.status === "down" ? "major" : "minor"));
const healthTitle = computed(() => {
  const h = health.value;
  if (!h) return "";
  const last = h.lastWriteAt ? new Date(h.lastWriteAt).toLocaleTimeString() : "never";
  return `installed: ${h.installedEvents.join(", ") || "none"} · fresh hook writes: ${h.freshWrites} · last: ${last}`;
});

// Staleness (drop sessions idle > 5 days, landed or not — unless noted) is enforced by the
// server now, so the board renders whatever it sends.
const boardAircraft = computed<Aircraft[]>(() => effectiveAircraft.value);

// order by when each entered its state, so tool calls / thinking don't reshuffle the
// board — a strip only moves when its state actually changes.
const orderKey = (a: { stateSince?: number | null; lastActivityAt: number | null }) =>
  a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) =>
  boardAircraft.value.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));

const inflight = computed(() => byLane("inflight"));
const mia = computed(() => byLane("mia"));
const parked = computed(() => byLane("parked"));
const landed = computed(() => byLane("landed"));
// holding: everything actively flashing "needs you" (parked ones live in their own lane now)
const holding = computed(() =>
  byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))),
);

const clock = computed(() => new Date(now.value).toLocaleTimeString());

// true only when served by the Vite dev server (pnpm ui / dev:live on :5173); false in the
// built bundle the installed app serves — so the DEV badge shows only on a dev board.
const isDev = import.meta.env.DEV;

// Bind the logo URL at runtime rather than `src="/logo.svg"`: a static src makes Vite
// inline the SVG as a data-URI at compile time, and in dev that inlined copy gets cached
// and goes stale when the file changes (the header showed the old logo while the favicon
// updated). A runtime binding is fetched as a plain URL, so it always reflects the file.
const logoUrl = "/logo.svg";

const settingsOpen = ref(false);
const helpOpen = ref(false);
// Open Help automatically on each visit until the user has closed it once (full board only).
function closeHelp() {
  helpOpen.value = false;
  localStorage.setItem("fc-help-seen", "1");
}
onMounted(() => {
  if (!panel && !localStorage.getItem("fc-help-seen")) helpOpen.value = true;
});

// What's new: auto-open once after the build number rises past what the user last saw. A dot
// on the header icon marks unseen changes. A brand-new install baselines silently (Help
// greets new users; the changelog is for returning ones after an update).
const whatsnewOpen = ref(false);
const seenBuild = ref<number | null>(Number(localStorage.getItem("fc-seen-build") ?? "") || null);
const hasUnseen = computed(() => currentBuild.value != null && seenBuild.value != null && currentBuild.value > seenBuild.value);
function closeWhatsnew() {
  whatsnewOpen.value = false;
  if (currentBuild.value != null) {
    seenBuild.value = currentBuild.value;
    localStorage.setItem("fc-seen-build", String(currentBuild.value));
  }
}
let whatsnewChecked = false;
watch(currentBuild, (b) => {
  if (whatsnewChecked || panel || overlay || b == null) return;
  whatsnewChecked = true;
  if (localStorage.getItem("fc-seen-build") == null) {
    seenBuild.value = b;
    localStorage.setItem("fc-seen-build", String(b)); // baseline a fresh install, no popup
  } else if (b > (seenBuild.value ?? 0)) {
    whatsnewOpen.value = true;
  }
});

// cross-column FLIP: measure before patch, tween from old → new screen position
let firstRects = new Map<string, DOMRect>();
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
onBeforeUpdate(() => {
  if (flight.value) return; // the flight-layer handles its own movement
  firstRects = new Map();
  document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => firstRects.set(el.dataset.fid!, el.getBoundingClientRect()));
});
onUpdated(() => {
  if (flight.value || reduceMotion) return;
  document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => {
    const first = firstRects.get(el.dataset.fid!);
    if (!first) return;
    const last = el.getBoundingClientRect();
    const dx = first.left - last.left;
    const dy = first.top - last.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)" });
  });
});

// wheel over the landed row scrolls it sideways (vertical wheel → horizontal), so you
// don't need a horizontal gesture to reach older landings.
function onLandedWheel(e: WheelEvent) {
  const el = e.currentTarget as HTMLElement;
  if (el.scrollWidth <= el.clientWidth) return; // nothing to scroll
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return; // let native horizontal gestures pass
  el.scrollLeft += e.deltaY;
  e.preventDefault();
}

// v-fade: mask a scroll container's edges, but only on the side(s) that still have
// hidden content — so a scrollable list looks like it continues rather than being cut.
const FADE = 28;
function updateFade(el: HTMLElement) {
  const xOver = el.scrollWidth - el.clientWidth > 1;
  const yOver = el.scrollHeight - el.clientHeight > 1;
  const build = (dir: string, start: boolean, end: boolean) => {
    const stops = [start ? "transparent 0" : "#000 0"];
    if (start) stops.push(`#000 ${FADE}px`);
    if (end) stops.push(`#000 calc(100% - ${FADE}px)`);
    stops.push(end ? "transparent 100%" : "#000 100%");
    return `linear-gradient(to ${dir}, ${stops.join(", ")})`;
  };
  let mask = "";
  // these containers each scroll a single axis — pick whichever actually overflows
  if (xOver && el.scrollWidth - el.clientWidth >= el.scrollHeight - el.clientHeight) {
    mask = build("right", el.scrollLeft > 1, el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  } else if (yOver) {
    mask = build("bottom", el.scrollTop > 1, el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }
  el.style.setProperty("-webkit-mask-image", mask);
  el.style.setProperty("mask-image", mask);
}
const fadeCleanups = new WeakMap<HTMLElement, () => void>();
const vFade = {
  mounted(el: HTMLElement) {
    const upd = () => updateFade(el);
    el.addEventListener("scroll", upd, { passive: true });
    const ro = new ResizeObserver(upd);
    ro.observe(el);
    fadeCleanups.set(el, () => { el.removeEventListener("scroll", upd); ro.disconnect(); });
    requestAnimationFrame(upd);
  },
  updated(el: HTMLElement) { requestAnimationFrame(() => updateFade(el)); },
  unmounted(el: HTMLElement) { fadeCleanups.get(el)?.(); fadeCleanups.delete(el); },
};

function onSet(id: string, note: string) { setNote(id, note); }
function onRemove(id: string) { removeNote(id); }
function onLand(id: string) { land(id); }
function onUnland(id: string) { unland(id); }
function onOpen(id: string) { open(id); }
</script>

<template>
  <Panel
    v-if="panel"
    :aircraft="boardAircraft"
    :now="now"
    :connected="connected"
    @set-note="onSet"
    @remove-note="onRemove"
    @land="onLand"
    @unland="onUnland"
    @open="onOpen"
  />
  <Overlay v-else-if="overlay" :aircraft="boardAircraft" :now="now" @open="onOpen" />
  <div v-else class="wrap">
    <a
      v-if="showStatus && status"
      class="status-bar"
      :class="'sev-' + statusSev"
      :href="status.url"
      target="_blank"
      rel="noreferrer"
      :title="'Claude service status — updated ' + new Date(status.updatedAt).toLocaleString()"
    >
      <i class="ti ti-alert-triangle"></i>
      <span class="s-desc">{{ status.incidents[0]?.name || status.description }}</span>
      <span class="s-chips">
        <span
          v-for="c in status.components"
          :key="c.name"
          class="s-badge"
          :style="{ color: statusColor(c.status), borderColor: statusColor(c.status) }"
        >{{ c.name }} · {{ prettyStatus(c.status) }}</span>
      </span>
      <span class="s-link">status.claude.com <i class="ti ti-external-link"></i></span>
    </a>

    <div
      v-if="showHealth && health"
      class="status-bar health-bar"
      :class="'sev-' + healthSev"
      :title="healthTitle"
    >
      <i class="ti ti-webhook"></i>
      <span class="s-desc">{{ health.detail }}</span>
      <span class="s-chips">
        <span
          v-for="e in health.missingRequired"
          :key="e"
          class="s-badge"
          :style="{ color: 'var(--red)', borderColor: 'var(--red)' }"
        >missing: {{ e }}</span>
      </span>
      <span class="s-link">{{ health.installedEvents.length }} hook{{ health.installedEvents.length === 1 ? '' : 's' }} wired</span>
    </div>

    <!-- a newer build is on `main`; the app applies it at startup, so prompt a restart -->
    <div v-if="update.available" class="status-bar sev-info">
      <i class="ti ti-arrow-up-circle"></i>
      <span class="s-desc">Update available{{ update.latest ? ' — ' + update.latest.pretty : '' }}</span>
      <button class="s-action" :disabled="updating" @click="applyUpdate">{{ updating ? 'Updating…' : 'Update now' }}</button>
    </div>

    <!-- a click that could not be routed (session gone, host never recorded) -->
    <div v-if="openHint" class="status-bar sev-info">
      <i class="ti ti-app-window"></i>
      <span class="s-desc">{{ openHint }}</span>
    </div>

    <header>
      <div class="brand">
        <img :src="logoUrl" class="brand-logo" alt="" />
        <span class="name"><span class="w1">Session</span><span class="w2">Controller</span></span>
        <span v-if="isDev" class="dev-badge" title="Development build (Vite dev server) — not the installed app">DEV</span>
      </div>
      <div class="stats">
        <span class="stat"><FlipCounter :value="holding.length" color="var(--amber)" /> holding</span>
        <span class="stat"><FlipCounter :value="inflight.length" color="var(--green)" /> in-flight</span>
        <span v-if="parked.length" class="stat"><FlipCounter :value="parked.length" color="var(--parked)" /> parked</span>
        <span v-if="mia.length" class="stat"><FlipCounter :value="mia.length" color="var(--gray)" /> mia</span>
        <span v-if="landed.length" class="stat"><FlipCounter :value="landed.length" color="#4cc38a" /> landed</span>
        <button class="bell wn-btn" data-tip="WHAT'S NEW" aria-label="What's new" @click="whatsnewOpen = true">
          <i class="ti ti-sparkles"></i>
          <span v-if="hasUnseen" class="wn-dot"></span>
        </button>
        <button class="bell" data-tip="SETTINGS" aria-label="Settings" @click="settingsOpen = true">
          <i class="ti ti-settings"></i>
        </button>
        <button class="bell help-btn" data-tip="HELP · READING THE BOARD" aria-label="Help" @click="helpOpen = true">?</button>
        <a
          class="bell coffee tip-right"
          href="https://buymeacoffee.com/davidsaysthankyou"
          target="_blank"
          rel="noreferrer"
          data-tip="BUY ME A COFFEE"
          aria-label="Buy me a coffee"
        >
          <svg class="coffee-icon" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="m20.216 6.415-.132-.666c-.119-.598-.388-1.163-1.001-1.379-.197-.069-.42-.098-.57-.241-.152-.143-.196-.366-.231-.572-.065-.378-.125-.756-.192-1.133-.057-.325-.102-.69-.25-.987-.195-.4-.597-.634-.996-.788a5.723 5.723 0 0 0-.626-.194c-1-.263-2.05-.36-3.077-.416a25.834 25.834 0 0 0-3.7.062c-.915.083-1.88.184-2.75.5-.318.116-.646.256-.888.501-.297.302-.393.77-.177 1.146.154.267.415.456.692.58.36.162.737.284 1.123.366 1.075.238 2.189.331 3.287.37 1.218.05 2.437.01 3.65-.118.299-.033.598-.073.896-.119.352-.054.578-.513.474-.834-.124-.383-.457-.531-.834-.473-.466.074-.96.108-1.382.146-1.177.08-2.358.082-3.536.006a22.228 22.228 0 0 1-1.157-.107c-.086-.01-.18-.025-.258-.036-.243-.036-.484-.08-.724-.13-.111-.027-.111-.185 0-.212h.005c.277-.06.557-.108.838-.147h.002c.131-.009.263-.032.394-.048a25.076 25.076 0 0 1 3.426-.12c.674.019 1.347.067 2.017.144l.228.031c.267.04.533.088.798.145.392.085.895.113 1.07.542.055.137.08.288.111.431l.319 1.484a.237.237 0 0 1-.199.284h-.003c-.037.006-.075.01-.112.015a36.704 36.704 0 0 1-4.743.295 37.059 37.059 0 0 1-4.699-.304c-.14-.017-.293-.042-.417-.06-.326-.048-.649-.108-.973-.161-.393-.065-.768-.032-1.123.161-.29.16-.527.404-.675.701-.154.316-.199.66-.267 1-.069.34-.176.707-.135 1.056.087.753.613 1.365 1.37 1.502a39.69 39.69 0 0 0 11.343.376.483.483 0 0 1 .535.53l-.071.697-1.018 9.907c-.041.41-.047.832-.125 1.237-.122.637-.553 1.028-1.182 1.171-.577.131-1.165.2-1.756.205-.656.004-1.31-.025-1.966-.022-.699.004-1.556-.06-2.095-.58-.475-.458-.54-1.174-.605-1.793l-.731-7.013-.322-3.094c-.037-.351-.286-.695-.678-.678-.336.015-.718.3-.678.679l.228 2.185.949 9.112c.147 1.344 1.174 2.068 2.446 2.272.742.12 1.503.144 2.257.156.966.016 1.942.053 2.892-.122 1.408-.258 2.465-1.198 2.616-2.657.34-3.332.683-6.663 1.024-9.995l.215-2.087a.484.484 0 0 1 .39-.426c.402-.078.787-.212 1.074-.518.455-.488.546-1.124.385-1.766zm-1.478.772c-.145.137-.363.201-.578.233-2.416.359-4.866.54-7.308.46-1.748-.06-3.477-.254-5.207-.498-.17-.024-.353-.055-.47-.18-.22-.236-.111-.71-.054-.995.052-.26.152-.609.463-.646.484-.057 1.046.148 1.526.22.577.088 1.156.159 1.737.212 2.48.226 5.002.19 7.472-.14.45-.06.899-.13 1.345-.21.399-.072.84-.206 1.08.206.166.281.188.657.162.974a.544.544 0 0 1-.169.364zm-6.159 3.9c-.862.37-1.84.788-3.109.788a5.884 5.884 0 0 1-1.569-.217l.877 9.004c.065.78.717 1.38 1.5 1.38 0 0 1.243.065 1.658.065.447 0 1.786-.065 1.786-.065.783 0 1.434-.6 1.499-1.38l.94-9.95a3.996 3.996 0 0 0-1.322-.238c-.826 0-1.491.284-2.26.613z"/></svg>
        </a>
        <span class="dot" :style="{ color: connected ? 'var(--green)' : 'var(--red)' }">
          <i class="ti ti-circle-filled"></i>{{ connected ? "live" : "reconnecting" }}
        </span>
        <span class="mono clock">{{ clock }}</span>
      </div>
    </header>

    <FlightBoard
      v-if="flight"
      :aircraft="boardAircraft"
      :now="now"
      :debug="debug"
      @set-note="onSet"
      @remove-note="onRemove"
      @land="onLand"
      @unland="onUnland"
      @open="onOpen"
      @dbg-cycle="onDbgCycle"
      @dbg-step="onDbgStep"
      @dbg-shuffle="onDbgShuffle"
      @dbg-reset="onDbgReset"
    />

    <div v-if="!flight" class="board">
      <!-- LEFT RAIL: MIA — every quiet, non-landed session (lost contact / dormant / done-ish) -->
      <aside v-if="mia.length" class="mia-rail">
        <div class="rail-h"><i class="ti ti-clock"></i> MIA — lost contact <span class="n">{{ mia.length }}</span></div>
        <div v-fade class="rail-stack">
          <Strip v-for="a in mia" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
        </div>
      </aside>

      <div class="main">
        <div class="band-h"><i class="ti ti-plane-inflight"></i>In-flight <span class="n">{{ inflight.length }}</span></div>
        <div v-fade class="band inflight-band">
          <Strip v-for="a in inflight" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
          <div v-if="!inflight.length" class="empty">no active sessions</div>
        </div>

        <!-- flexible middle: holding / parked absorb the height and scroll internally -->
        <div class="lanes">
          <section class="lane holding-lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--amber)"></i>Holding <span class="n">{{ holding.length }}</span></div>
            <div v-fade class="stack">
              <Strip v-for="a in holding" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
              <div v-if="!holding.length" class="empty">clear</div>
            </div>
          </section>

          <section class="lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--parked)"></i>Parked <span class="n">{{ parked.length }}</span></div>
            <div v-fade class="stack">
              <Strip v-for="a in parked" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
              <div v-if="!parked.length" class="empty">clear</div>
            </div>
          </section>
        </div>

        <!-- LANDED: one row of recent landings (older than 7 days are hidden) -->
        <div v-if="landed.length" class="landed-region">
          <div class="band-h landed-h">
            <i class="ti ti-plane-arrival"></i>Landed <span class="n">{{ landed.length }}</span>
          </div>
          <div v-fade class="band landed-band" @wheel="onLandedWheel">
            <Strip v-for="a in landed" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
          </div>
        </div>
      </div>
    </div>

    <Settings
      v-if="settingsOpen"
      :flight="flight"
      :notify-supported="notifySupported"
      :notify-enabled="notifyEnabled"
      :version="version"
      @toggle-flight="toggleFlight"
      @toggle-notify="toggleNotify"
      @close="settingsOpen = false"
    />
    <Help v-if="helpOpen" @close="closeHelp" />
    <Whatsnew v-if="whatsnewOpen" :since-build="seenBuild" @close="closeWhatsnew" />
    <div v-if="version" class="version-tag">{{ version }}</div>
  </div>
</template>

<style scoped>
.wrap { height: 100dvh; max-width: 1600px; margin: 0 auto; padding: 14px 16px 16px; display: flex; flex-direction: column; overflow: hidden; }

/* Claude service-status banner (only shown when something is not operational) */
.status-bar { flex: none; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; text-decoration: none; margin-bottom: 8px; padding: 6px 12px; border-radius: 8px; font-size: 12px; border: 0.5px solid; }
.status-bar.sev-minor { background: rgba(224, 169, 46, 0.09); border-color: rgba(224, 169, 46, 0.35); }
.status-bar.sev-major { background: rgba(248, 81, 73, 0.1); border-color: rgba(248, 81, 73, 0.4); }
.status-bar.sev-info { background: rgba(88, 166, 255, 0.09); border-color: rgba(88, 166, 255, 0.3); }
.status-bar > i { font-size: 14px; color: var(--amber); }
.status-bar.sev-major > i { color: var(--red); }
.status-bar.sev-info > i { color: var(--blue); }
.s-desc { font-weight: 600; color: var(--text-hi); }
.s-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.s-badge { font-size: 11px; border: 0.5px solid; border-radius: 6px; padding: 0 6px; white-space: nowrap; }
.s-link { margin-left: auto; color: var(--text-dim); display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.s-link i { font-size: 12px; }
.s-action { all: unset; margin-left: auto; cursor: pointer; font-size: 11px; font-weight: 600; color: var(--blue); border: 0.5px solid color-mix(in srgb, var(--blue) 50%, transparent); border-radius: 6px; padding: 3px 10px; white-space: nowrap; }
.s-action:hover { background: color-mix(in srgb, var(--blue) 15%, transparent); }
.s-action:disabled { opacity: 0.6; cursor: default; }
header { flex: none; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
.brand { display: flex; align-items: center; gap: 9px; }
.brand-logo { width: 26px; height: 26px; display: block; }
/* only rendered under the Vite dev server (pnpm ui / dev:live) — flags a non-installed board */
.dev-badge {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em;
  color: var(--bg); background: var(--amber);
  padding: 2px 6px; border-radius: 5px; line-height: 1;
  box-shadow: 0 0 8px color-mix(in srgb, var(--amber) 55%, transparent);
}
/* airport-signage wordmark: wide tracking + a light/bold weight pairing (transit-brand look) */
.name { display: inline-flex; align-items: baseline; gap: 0.5em; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; text-transform: uppercase; font-size: 15px; line-height: 1; }
.name .w1 { font-weight: 300; letter-spacing: 0.34em; color: var(--text-dim); }
.name .w2 { font-weight: 700; letter-spacing: 0.34em; color: var(--text-hi); }
.stats { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-dim); }
.stats b { font-weight: 500; }
.stat { display: inline-flex; align-items: center; gap: 6px; }
.dot { display: inline-flex; align-items: center; gap: 5px; }
.dot i { font-size: 8px; }
.clock { color: var(--text-faint); }
.bell { all: unset; cursor: pointer; display: inline-flex; align-items: center; padding: 3px; border-radius: 6px; color: var(--text-faint); font-size: 14px; }
.bell:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.bell.on { color: var(--amber); }
.wn-btn { position: relative; }
.wn-dot { position: absolute; top: 1px; right: 1px; width: 6px; height: 6px; border-radius: 50%; background: var(--amber); box-shadow: 0 0 5px color-mix(in srgb, var(--amber) 70%, transparent); }

/* MCDU-style tooltip: phosphor-green monospace on a dark CRT screen — fits the ATC theme */
.bell[data-tip] { position: relative; }
.bell[data-tip]::after {
  content: attr(data-tip);
  position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%) translateY(3px);
  font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  font-size: 9.5px; letter-spacing: 0.16em; text-transform: uppercase; white-space: nowrap;
  color: #5ef0a0; background: #04080c; border: 0.5px solid rgba(94, 240, 160, 0.4); border-radius: 4px;
  padding: 4px 8px; text-shadow: 0 0 6px rgba(94, 240, 160, 0.55);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.55), inset 0 0 10px rgba(94, 240, 160, 0.07);
  opacity: 0; pointer-events: none; z-index: 70; transition: opacity 0.12s ease, transform 0.12s ease;
}
.bell[data-tip]::before {
  content: ""; position: absolute; top: calc(100% + 2px); left: 50%; transform: translateX(-50%) translateY(3px);
  border: 4px solid transparent; border-bottom-color: rgba(94, 240, 160, 0.5);
  opacity: 0; pointer-events: none; z-index: 70; transition: opacity 0.12s ease, transform 0.12s ease;
}
.bell[data-tip]:hover::after, .bell[data-tip]:hover::before { opacity: 1; transform: translateX(-50%) translateY(0); }
/* rightmost icon: anchor the tooltip to the right so it can't spill off-screen */
.bell[data-tip].tip-right::after { left: auto; right: 0; transform: translateX(0) translateY(3px); }
.bell[data-tip].tip-right:hover::after { transform: translateX(0) translateY(0); }
.coffee:hover { background: rgba(255, 221, 0, 0.14); color: #ffdd00; }
.coffee-icon { display: block; }
/* help "?" is text, not a glyph — the font lacks a plain question mark, and the circled
   variants render the mark too small to read at this size */
.help-btn { font-size: 15px; font-weight: 700; line-height: 1; width: 20px; justify-content: center; }

/* board: MIA rail on the left, everything else in the main column */
.board { flex: 1; min-height: 0; display: flex; gap: 12px; padding-top: 12px; }
.mia-rail { flex: none; width: 234px; display: flex; flex-direction: column; min-height: 0; border: 0.5px dashed var(--border); border-radius: 10px; padding: 8px; background: rgba(255,255,255,0.012); }
.rail-h { flex: none; display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--gray); margin-bottom: 8px; }
.rail-h .n { color: var(--text-faint); font-weight: 400; }
.rail-stack { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
/* strips in a scrolling flex column must NOT shrink, or 76 of them compress to slivers */
.rail-stack > *, .stack > * { flex: 0 0 auto; }

.main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }

.band-h, .lane-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text); }
.band-h { color: var(--green); margin: 0 0 8px; flex: none; }
.band-h.landed-h { color: #4cc38a; }
.band-h .n, .lane-h .n { color: var(--text-faint); font-weight: 400; }
.lane-h i { font-size: 9px; }

.band { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; align-content: start; }
.inflight-band { flex: 0 0 auto; max-height: 34%; overflow-y: auto; }

/* the flexible middle — takes all the slack, each lane scrolls internally when crowded */
.lanes { flex: 1 1 0; min-height: 0; display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; align-items: stretch; margin-top: 12px; }
.lane { background: var(--panel); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; min-height: 0; }
.lane .lane-h { margin-bottom: 8px; padding: 0 2px; flex: none; }
.stack { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.empty { font-size: 11px; color: var(--text-faint); padding: 6px 2px; }

/* landed pinned at the bottom as ONE row of recent landings (older than 7 days hidden) */
.landed-region { flex: none; display: flex; flex-direction: column; margin-top: 14px; }
.landed-region .landed-h { margin-bottom: 8px; flex: none; }
/* single row, scrolls sideways; align-items:stretch makes every card as tall as the tallest */
.landed-band { display: flex; flex-wrap: nowrap; align-items: stretch; grid-template-columns: none; gap: 8px; overflow-x: auto; overflow-y: hidden; padding-bottom: 12px; }
.landed-band > * { flex: 0 0 232px; min-width: 0; }

/* subtle build stamp, bottom-right — a quick "did my update land?" glance */
.version-tag {
  position: fixed; bottom: 5px; right: 9px; z-index: 1; pointer-events: none;
  font: 10px/1 ui-monospace, "SF Mono", Menlo, monospace; letter-spacing: 0.02em;
  color: var(--text-faint); opacity: 0.5; user-select: none;
}

@media (max-width: 900px) { .lanes { grid-template-columns: 1fr; } .mia-rail { width: 200px; } }
</style>
