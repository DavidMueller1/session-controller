<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import Strip from "./Strip.vue";
import { laneOf, isFlashing } from "../format";
import type { Aircraft } from "../types";

// SPIKE: one absolutely-positioned coordinate space ("the sky"). Every strip is rendered
// exactly once and placed at a computed slot rect for its lane — so a lane change moves
// the SAME element (it can later travel + morph shape) instead of being destroyed here
// and recreated there. No fancy transitions yet; just proving positioning + slots.

const props = defineProps<{ aircraft: Aircraft[]; now: number }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
  open: [id: string];
}>();

const orderKey = (a: Aircraft) => a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) => props.aircraft.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));
const inflight = computed(() => byLane("inflight"));
const holding = computed(() => byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))));
const approach = computed(() => byLane("approach"));
const landed = computed(() => byLane("landed"));
const mia = computed(() => byLane("mia"));

const sky = ref<HTMLElement | null>(null);
const skyW = ref(1200);
const skyH = ref(700);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => {
    const el = sky.value;
    if (el) {
      skyW.value = el.clientWidth;
      skyH.value = el.clientHeight;
    }
  });
  if (sky.value) ro.observe(sky.value);
});
onBeforeUnmount(() => ro?.disconnect());

// geometry
const GAP = 8;
const HEAD = 22; // room for a lane label above each zone
const CARD_W = 220;
const PITCH_CARD = 128; // vertical pitch for card slots (In-flight / Landed)
const PITCH_ROW = 116; // vertical pitch for full-width rows (Holding / Approach)
const RAIL_W = 226;
const PITCH_RAIL = 110;

interface Rect { x: number; y: number; w: number; h: number }

const railW = computed(() => (mia.value.length ? RAIL_W : 0));
const contentX = computed(() => (railW.value ? railW.value + GAP : 0));
const contentW = computed(() => Math.max(260, skyW.value - contentX.value));
const cols = computed(() => Math.max(1, Math.floor((contentW.value + GAP) / (CARD_W + GAP))));
const inflightRows = computed(() => Math.max(1, Math.ceil(inflight.value.length / cols.value)));
const lanesTop = computed(() => HEAD + inflightRows.value * PITCH_CARD + GAP + HEAD);
const holdW = computed(() => Math.max(220, contentW.value * 0.6 - GAP / 2));
const appX = computed(() => contentX.value + contentW.value * 0.6 + GAP / 2);
const appW = computed(() => Math.max(180, contentW.value * 0.4 - GAP / 2));
const landedY = computed(() => Math.max(lanesTop.value, skyH.value - PITCH_CARD));

const rects = computed<Record<string, Rect>>(() => {
  const r: Record<string, Rect> = {};
  const cx = contentX.value;
  inflight.value.forEach((a, i) => {
    const row = Math.floor(i / cols.value);
    const col = i % cols.value;
    r[a.id] = { x: cx + col * (CARD_W + GAP), y: HEAD + row * PITCH_CARD, w: CARD_W, h: PITCH_CARD - GAP };
  });
  holding.value.forEach((a, i) => {
    r[a.id] = { x: cx, y: lanesTop.value + i * PITCH_ROW, w: holdW.value, h: PITCH_ROW - GAP };
  });
  approach.value.forEach((a, i) => {
    r[a.id] = { x: appX.value, y: lanesTop.value + i * PITCH_ROW, w: appW.value, h: PITCH_ROW - GAP };
  });
  landed.value.forEach((a, i) => {
    r[a.id] = { x: cx + i * (CARD_W + GAP), y: landedY.value, w: CARD_W, h: PITCH_CARD - GAP };
  });
  mia.value.forEach((a, i) => {
    r[a.id] = { x: 0, y: HEAD + i * PITCH_RAIL, w: RAIL_W - GAP, h: PITCH_RAIL - GAP };
  });
  return r;
});

const zones = computed(() => {
  const cx = contentX.value;
  const list = [
    { k: "In-flight", x: cx, y: 0, c: "var(--green)" },
    { k: "Holding", x: cx, y: lanesTop.value - HEAD, c: "var(--amber)" },
    { k: "Approach", x: appX.value, y: lanesTop.value - HEAD, c: "var(--blue)" },
    { k: "Landed", x: cx, y: landedY.value - HEAD, c: "#4cc38a" },
  ];
  if (mia.value.length) list.push({ k: "MIA", x: 0, y: 0, c: "var(--gray)" });
  return list;
});

const placed = computed(() => props.aircraft.filter((a) => rects.value[a.id]));
</script>

<template>
  <div ref="sky" class="sky">
    <div v-for="z in zones" :key="z.k" class="zone-label" :style="{ transform: `translate(${z.x}px, ${z.y}px)`, color: z.c }">
      {{ z.k }}
    </div>
    <div
      v-for="a in placed"
      :key="a.id"
      class="slot"
      :data-fid="a.id"
      :style="{ transform: `translate(${rects[a.id].x}px, ${rects[a.id].y}px)`, width: rects[a.id].w + 'px', height: rects[a.id].h + 'px' }"
    >
      <Strip
        :aircraft="a"
        :now="now"
        @set-note="(id, n) => emit('setNote', id, n)"
        @remove-note="(id) => emit('removeNote', id)"
        @land="(id) => emit('land', id)"
        @unland="(id) => emit('unland', id)"
        @open="(id) => emit('open', id)"
      />
    </div>
  </div>
</template>

<style scoped>
.sky { position: relative; flex: 1; min-height: 0; overflow: hidden; margin-top: 8px; }
.zone-label { position: absolute; top: 0; left: 0; font-size: 11px; font-weight: 500; letter-spacing: 0.3px; opacity: 0.85; pointer-events: none; z-index: 1; }
/* the payoff: because slots share one coordinate space, a lane change is a transform +
   size tween on the SAME node — the strip travels instead of teleporting. */
.slot { position: absolute; top: 0; left: 0; overflow: hidden; transition: transform 0.5s cubic-bezier(0.2, 0.7, 0.2, 1), width 0.5s cubic-bezier(0.2, 0.7, 0.2, 1); }
.slot :deep(.strip) { height: 100%; }
</style>
