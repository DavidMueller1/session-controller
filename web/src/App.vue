<script setup lang="ts">
import { computed, onBeforeUpdate, onMounted, onUpdated, ref } from "vue";
import Strip from "./components/Strip.vue";
import { useBoard } from "./useBoard";
import { laneOf, isFlashing } from "./format";

const { aircraft, status, connected, now, start, setNote, removeNote, land, unland, open, notifySupported, notifyEnabled, toggleNotify } = useBoard();
onMounted(start);

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

// order by when each entered its state, so tool calls / thinking don't reshuffle the
// board — a strip only moves when its state actually changes.
const orderKey = (a: { stateSince?: number | null; lastActivityAt: number | null }) =>
  a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) =>
  aircraft.value.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));

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
  firstRects = new Map();
  document.querySelectorAll<HTMLElement>("[data-fid]").forEach((el) => firstRects.set(el.dataset.fid!, el.getBoundingClientRect()));
});
onUpdated(() => {
  if (reduceMotion) return;
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

    <header>
      <div class="brand">
        <img src="/logo.svg" class="brand-logo" alt="" />
        <span class="name">FEATURE CONTROLLER</span>
      </div>
      <div class="stats">
        <span><b style="color: var(--amber)">{{ holding.length }}</b> holding</span>
        <span><b style="color: var(--green)">{{ inflight.length }}</b> in-flight</span>
        <span v-if="mia.length"><b style="color: var(--gray)">{{ mia.length }}</b> mia</span>
        <span><b style="color: var(--blue)">{{ approach.length }}</b> approach</span>
        <span v-if="landed.length"><b style="color: #4cc38a">{{ landed.length }}</b> landed</span>
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

    <div class="board">
      <!-- LEFT RAIL: MIA — every quiet, non-landed session (lost contact / dormant / done-ish) -->
      <aside v-if="mia.length" class="mia-rail">
        <div class="rail-h"><i class="ti ti-clock"></i> MIA — lost contact <span class="n">{{ mia.length }}</span></div>
        <div class="rail-stack">
          <Strip v-for="a in mia" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
        </div>
      </aside>

      <div class="main">
        <div class="band-h"><i class="ti ti-plane-inflight"></i>In-flight <span class="n">{{ inflight.length }}</span></div>
        <div class="band inflight-band">
          <Strip v-for="a in inflight" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
          <div v-if="!inflight.length" class="empty">no active sessions</div>
        </div>

        <!-- flexible middle: holding / approach absorb the height and scroll internally -->
        <div class="lanes">
          <section class="lane holding-lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--amber)"></i>Holding <span class="n">{{ holding.length }}</span></div>
            <div class="stack">
              <Strip v-for="a in holding" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" @open="onOpen" />
              <div v-if="!holding.length" class="empty">clear</div>
            </div>
          </section>

          <section class="lane">
            <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--blue)"></i>Approach <span class="n">{{ approach.length }}</span></div>
            <div class="stack">
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
          <div class="band landed-band" @wheel="onLandedWheel">
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
        <div class="cold-panel-grid">
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
