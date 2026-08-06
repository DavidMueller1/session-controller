<script setup lang="ts">
import { computed, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, ref, watch } from "vue";
import Strip from "./components/Strip.vue";
import FlightBoard from "./components/FlightBoard.vue";
import FlipCounter from "./components/FlipCounter.vue";
import { useBoard } from "./useBoard";
import { laneOf, isFlashing } from "./format";
import type { Aircraft } from "./types";

const { aircraft, status, health, connected, now, start, setNote, removeNote, land, unland, open, notifySupported, notifyEnabled, toggleNotify } = useBoard();
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
type DebugState = "working" | "needs-input" | "error" | "approach" | "landed" | "mia" | "wrapped";
const DEBUG_STATES: DebugState[] = ["working", "needs-input", "error", "approach", "landed", "mia", "wrapped"];
const debugOverride = ref<Record<string, DebugState>>({});
watch(debug, (on) => { if (!on) debugOverride.value = {}; });

function applyDebug(a: Aircraft, ds: DebugState): Aircraft {
  const base = { ...a, landed: false, approach: false, note: null };
  switch (ds) {
    case "working": return { ...base, state: "working" };
    case "needs-input": return { ...base, state: "needs-input" };
    case "error": return { ...base, state: "error" };
    case "approach": return { ...base, state: "needs-input", approach: true };
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

// order by when each entered its state, so tool calls / thinking don't reshuffle the
// board — a strip only moves when its state actually changes.
const orderKey = (a: { stateSince?: number | null; lastActivityAt: number | null }) =>
  a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) =>
  effectiveAircraft.value.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));

const inflight = computed(() => byLane("inflight"));
const mia = computed(() => byLane("mia"));
const approach = computed(() => byLane("approach"));
const landed = computed(() => byLane("landed"));
// holding: flashing "needs you" strips first, parked ones after
const holding = computed(() =>
  byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))),
);

// Landed = one horizontally-scrollable row of recent landings; anything last active
// more than 10 days ago drops into the Cold drawer (opened on demand).
const TEN_DAYS = 10 * 24 * 60 * 60 * 1000;
const landedAge = (a: { stateSince?: number | null; lastActivityAt: number | null }) =>
  now.value - (a.stateSince ?? a.lastActivityAt ?? now.value);
const landedVisible = computed(() => landed.value.filter((a) => landedAge(a) <= TEN_DAYS));
const cold = computed(() => landed.value.filter((a) => landedAge(a) > TEN_DAYS));
const showCold = ref(false);

const clock = computed(() => new Date(now.value).toLocaleTimeString());

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
  <div class="wrap">
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

    <header>
      <div class="brand">
        <img src="/logo.svg" class="brand-logo" alt="" />
        <span class="name">SESSION CONTROLLER</span>
      </div>
      <div class="stats">
        <span class="stat"><FlipCounter :value="holding.length" color="var(--amber)" /> holding</span>
        <span class="stat"><FlipCounter :value="inflight.length" color="var(--green)" /> in-flight</span>
        <span v-if="mia.length" class="stat"><FlipCounter :value="mia.length" color="var(--gray)" /> mia</span>
        <span class="stat"><FlipCounter :value="approach.length" color="var(--blue)" /> approach</span>
        <span v-if="landed.length" class="stat"><FlipCounter :value="landed.length" color="#4cc38a" /> landed</span>
        <button
          class="bell"
          :title="flight ? 'Flight board — switch to the simple list' : 'Simple list — switch to the flight board'"
          aria-label="Toggle board layout"
          @click="toggleFlight"
        >
          <i class="ti" :class="flight ? 'ti-plane' : 'ti-layout-list'"></i>
        </button>
        <button
          v-if="notifySupported"
          class="bell"
          :class="{ on: notifyEnabled }"
          :title="notifyEnabled ? 'Holding notifications on — click to mute' : 'Notify me when a session needs me'"
          :aria-label="notifyEnabled ? 'Mute holding notifications' : 'Enable holding notifications'"
          @click="toggleNotify"
        >
          <i class="ti" :class="notifyEnabled ? 'ti-bell' : 'ti-bell-off'"></i>
        </button>
        <span class="dot" :style="{ color: connected ? 'var(--green)' : 'var(--red)' }">
          <i class="ti ti-circle-filled"></i>{{ connected ? "live" : "reconnecting" }}
        </span>
        <span class="mono clock">{{ clock }}</span>
      </div>
    </header>

    <FlightBoard
      v-if="flight"
      :aircraft="effectiveAircraft"
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

        <!-- flexible middle: holding / approach absorb the height and scroll internally -->
        <div class="lanes">
          <section class="lane holding-lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--amber)"></i>Holding <span class="n">{{ holding.length }}</span></div>
            <div v-fade class="stack">
              <Strip v-for="a in holding" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
              <div v-if="!holding.length" class="empty">clear</div>
            </div>
          </section>

          <section class="lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--blue)"></i>Approach <span class="n">{{ approach.length }}</span></div>
            <div v-fade class="stack">
              <Strip v-for="a in approach" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
              <div v-if="!approach.length" class="empty">clear</div>
            </div>
          </section>
        </div>

        <!-- LANDED: one row of the most-recent that fit; the older tail goes to Cold -->
        <div v-if="landed.length" class="landed-region">
          <div class="band-h landed-h">
            <i class="ti ti-plane-arrival"></i>Landed <span class="n">{{ landedVisible.length }}</span>
            <button v-if="cold.length" class="cold-chip" title="Landed more than 10 days ago" @click="showCold = true">
              <i class="ti ti-stack-2"></i> {{ cold.length }} cold
            </button>
          </div>
          <div v-fade class="band landed-band" @wheel="onLandedWheel">
            <Strip v-for="a in landedVisible" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
          </div>
        </div>
      </div>
    </div>

    <!-- COLD: older landed, opened on demand and scrolled through -->
    <div v-if="showCold" class="cold-overlay" @click.self="showCold = false">
      <div class="cold-panel">
        <div class="cold-panel-h">
          <span><i class="ti ti-plane-arrival"></i> Cold — {{ cold.length }} older landed</span>
          <button class="icon" aria-label="close" @click="showCold = false"><i class="ti ti-x"></i></button>
        </div>
        <div v-fade class="cold-panel-grid">
          <Strip v-for="a in cold" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
        </div>
      </div>
    </div>
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
header { flex: none; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
.brand { display: flex; align-items: center; gap: 9px; }
.brand-logo { width: 26px; height: 26px; display: block; }
.name { font-size: 15px; font-weight: 500; letter-spacing: 0.4px; }
.stats { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-dim); }
.stats b { font-weight: 500; }
.stat { display: inline-flex; align-items: center; gap: 6px; }
.dot { display: inline-flex; align-items: center; gap: 5px; }
.dot i { font-size: 8px; }
.clock { color: var(--text-faint); }
.bell { all: unset; cursor: pointer; display: inline-flex; align-items: center; padding: 3px; border-radius: 6px; color: var(--text-faint); font-size: 14px; }
.bell:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.bell.on { color: var(--amber); }

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

/* landed pinned at the bottom as ONE row of what fits; the older tail goes to Cold.
   overflow:hidden (not auto) — no scrollbar; we render only the tiles that fit. */
.landed-region { flex: none; display: flex; flex-direction: column; margin-top: 14px; }
.landed-region .landed-h { margin-bottom: 8px; flex: none; }
.cold-chip { all: unset; cursor: pointer; margin-left: 8px; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-faint); border: 0.5px dashed var(--border); border-radius: 6px; padding: 1px 7px; }
.cold-chip:hover { color: var(--text-dim); border-color: var(--gray); }
/* single row, scrolls sideways; align-items:stretch makes every card as tall as the tallest */
.landed-band { display: flex; flex-wrap: nowrap; align-items: stretch; grid-template-columns: none; gap: 8px; overflow-x: auto; overflow-y: hidden; padding-bottom: 12px; }
.landed-band > * { flex: 0 0 232px; min-width: 0; }

/* cold: an on-demand overlay list, scrolled through (we rarely visit it) */
.cold-overlay { position: fixed; inset: 0; z-index: 40; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.cold-panel { width: min(1100px, 92vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0,0,0,0.5); overflow: hidden; }
.cold-panel-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 500; color: var(--text); }
.cold-panel-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.cold-panel-h .icon:hover { background: rgba(255,255,255,0.08); color: var(--text-dim); }
.cold-panel-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; padding: 12px 14px; align-content: start; }

@media (max-width: 900px) { .lanes { grid-template-columns: 1fr; } .mia-rail { width: 200px; } }
</style>
