<script setup lang="ts">
import { computed, onBeforeUpdate, onMounted, onUpdated, ref } from "vue";
import Strip from "./components/Strip.vue";
import { useBoard } from "./useBoard";
import { laneOf, isFlashing, isMia } from "./format";
import type { Aircraft } from "./types";

const { aircraft, connected, now, start, setNote, removeNote, land, unland } = useBoard();
onMounted(start);

const byLane = (lane: string) =>
  aircraft.value
    .filter((a) => laneOf(a) === lane)
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));

// in-flight: active first, MIA (lost contact) drifts to the end of the band
const inflight = computed(() =>
  byLane("inflight").sort((a, b) => Number(isMia(a)) - Number(isMia(b))),
);
const approach = computed(() => byLane("approach"));
const cold = computed(() => byLane("cold"));
const landed = computed(() => byLane("landed"));
// holding: flashing "needs you" strips first, parked ones after
const holding = computed(() =>
  byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))),
);

const clock = computed(() => new Date(now.value).toLocaleTimeString());
const showCold = ref(false);

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

function onSet(id: string, note: string) { setNote(id, note); }
function onRemove(id: string) { removeNote(id); }
function onLand(id: string) { land(id); }
function onUnland(id: string) { unland(id); }
</script>

<template>
  <div class="wrap">
    <header>
      <div class="brand">
        <i class="ti ti-plane-tilt" style="color: var(--green)"></i>
        <span class="name">FEATURE CONTROLLER</span>
      </div>
      <div class="stats">
        <span><b style="color: var(--amber)">{{ holding.length }}</b> holding</span>
        <span><b style="color: var(--green)">{{ inflight.length }}</b> in-flight</span>
        <span><b style="color: var(--blue)">{{ approach.length }}</b> approach</span>
        <span v-if="landed.length"><b style="color: #4cc38a">{{ landed.length }}</b> landed</span>
        <span class="dot" :style="{ color: connected ? 'var(--green)' : 'var(--red)' }">
          <i class="ti ti-circle-filled"></i>{{ connected ? "live" : "reconnecting" }}
        </span>
        <span class="mono clock">{{ clock }}</span>
      </div>
    </header>

    <div class="band-h"><i class="ti ti-plane-inflight"></i>In-flight <span class="n">{{ inflight.length }}</span></div>
    <div class="band">
      <Strip v-for="a in inflight" :key="a.id" :aircraft="a" :now="now" class="band-item" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" />
      <div v-if="!inflight.length" class="empty">no active sessions</div>
    </div>

    <div class="horizon"><span></span><label>horizon</label><span></span></div>

    <div class="lanes">
      <section class="lane holding-lane">
        <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--amber)"></i>Holding <span class="n">{{ holding.length }}</span></div>
        <div class="stack">
          <Strip v-for="a in holding" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" />
          <div v-if="!holding.length" class="empty">clear</div>
        </div>
      </section>

      <section class="lane">
        <div class="lane-h"><i class="ti ti-circle-filled" style="color: var(--blue)"></i>Approach <span class="n">{{ approach.length }}</span></div>
        <div class="stack">
          <Strip v-for="a in approach" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" />
          <div v-if="!approach.length" class="empty">clear</div>
        </div>
      </section>
    </div>

    <template v-if="landed.length">
      <div class="band-h landed-h"><i class="ti ti-plane-arrival"></i>Landed <span class="n">{{ landed.length }}</span></div>
      <div class="band">
        <Strip v-for="a in landed" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" />
      </div>
    </template>

    <div class="cold" @click="showCold = !showCold">
      <i class="ti" :class="showCold ? 'ti-chevron-down' : 'ti-chevron-right'"></i>
      <i class="ti ti-circle-filled" style="font-size: 8px; color: var(--text-faint)"></i>
      {{ cold.length }} cold — no recent activity (overnight-safe, not landed)
    </div>
    <div v-if="showCold" class="cold-grid">
      <Strip v-for="a in cold" :key="a.id" :aircraft="a" :now="now" @set-note="onSet" @remove-note="onRemove" @land="onLand" @unland="onUnland" />
    </div>
  </div>
</template>

<style scoped>
.wrap { max-width: 1600px; margin: 0 auto; padding: 14px 16px 28px; }
header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border-soft); }
.brand { display: flex; align-items: center; gap: 9px; }
.brand i { font-size: 20px; }
.name { font-size: 15px; font-weight: 500; letter-spacing: 0.4px; }
.stats { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-dim); }
.stats b { font-weight: 500; }
.dot { display: inline-flex; align-items: center; gap: 5px; }
.dot i { font-size: 8px; }
.clock { color: var(--text-faint); }
.band-h, .lane-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; color: var(--text); }
.band-h { color: var(--green); margin: 12px 0 8px; }
.band-h.landed-h { color: #4cc38a; margin-top: 18px; }
.band-h .n, .lane-h .n { color: var(--text-faint); font-weight: 400; }
.lane-h i { font-size: 9px; }
.band { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; }
.horizon { display: flex; align-items: center; gap: 8px; margin: 14px 0 12px; }
.horizon span { flex: 1; height: 1px; background: var(--border-soft); }
.horizon label { font-size: 10px; color: #4d5560; letter-spacing: 1px; }
.lanes { display: grid; grid-template-columns: 1.4fr 1fr; gap: 10px; align-items: start; }
.lane { background: var(--panel); border-radius: 10px; padding: 8px; }
.lane .lane-h { margin-bottom: 8px; padding: 0 2px; }
.stack { display: flex; flex-direction: column; gap: 8px; min-height: 34px; }
.empty { font-size: 11px; color: var(--text-faint); padding: 6px 2px; }
.cold { margin-top: 14px; display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 0.5px dashed var(--border); border-radius: 10px; color: var(--text-faint); font-size: 12px; cursor: pointer; }
.cold-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 8px; margin-top: 8px; }
@media (max-width: 900px) { .lanes { grid-template-columns: 1fr; } }
</style>
