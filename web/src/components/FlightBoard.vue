<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, onUpdated, ref, watch } from "vue";
import Strip from "./Strip.vue";
import { laneOf, isFlashing } from "../format";
import type { Aircraft, Lane } from "../types";

// Flight-layer (desktop only). One absolutely-positioned "sky" with REAL empty corridors
// between lanes. A lane change shrinks the strip into a small target-coloured travel token
// sized to fit the taxiway, routes it ALONG the corridor rails (never over resting strips)
// and expands it into the destination lane — while that lane's strips reflow to make way.
// Holding/Approach dock to the SIDE (vertical corridors); In-flight/Landed dock top/bottom.

const props = defineProps<{ aircraft: Aircraft[]; now: number; debug?: boolean }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
  open: [id: string];
}>();

// --- debug: force strips between lanes on demand (client-side overrides only) ---
const override = ref<Record<string, Lane>>({});
watch(() => props.debug, (on) => { if (!on) override.value = {}; });
const LANES: Lane[] = ["inflight", "holding", "approach", "landed", "mia"];
const LANE_COLOR: Record<string, string> = { inflight: "#3fb950", holding: "#e0a92e", approach: "#58a6ff", landed: "#4cc38a", mia: "#7d8590", cold: "#4d5560" };
const effectiveLane = (a: Aircraft): Lane => override.value[a.id] ?? laneOf(a);

const orderKey = (a: Aircraft) => a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) => props.aircraft.filter((a) => effectiveLane(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));
const inflight = computed(() => byLane("inflight"));
const holding = computed(() => byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))));
const approach = computed(() => byLane("approach"));
const landed = computed(() => byLane("landed"));
const mia = computed(() => byLane("mia"));

const stage = ref<HTMLElement | null>(null);
const skyW = ref(1400);
const skyH = ref(760);
let ro: ResizeObserver | null = null;
onMounted(() => {
  ro = new ResizeObserver(() => {
    const el = stage.value;
    if (el) { skyW.value = el.clientWidth; skyH.value = el.clientHeight; }
  });
  if (stage.value) ro.observe(stage.value);
});
onBeforeUnmount(() => ro?.disconnect());

const travelMs = ref(800);

// geometry (fixed, desktop)
const GAP = 8; // gap between strips within a lane (kept — this spacing is good)
const TOP = 8; // top padding of the board content
const LABEL_W = 14; // width of the vertical lane-label gutter on the left of each lane
const LGAP = 4; // gap between a vertical label and its lane content
const LANE_PAD = 6; // breathing room between the taxiways and the lane content
const COR = 52; // corridor thickness — the real empty travel space between lanes
const RAIL_W = 240; // permanent MIA column
const CARD_W = 220;
const CARD_H = 134; // taller slots so title + chips + summary + PR/footer + buttons all fit
const ROW_H = 132; // (row content = ROW_H - GAP)
const RAIL_H = 124;
const PUCK_W = 44; // travel token — fits inside a corridor in either orientation
const PUCK_H = 34;

interface Rect { x: number; y: number; w: number; h: number }
interface Pt { x: number; y: number }

const L = computed(() => {
  const W = skyW.value;
  const H = skyH.value;
  const contentX = RAIL_W + COR;
  const contentW = Math.max(360, W - contentX);
  const laneL = contentX + LANE_PAD; // left of a lane = its vertical-label gutter
  const cardX = laneL + LABEL_W + LGAP; // where band/holding cards begin
  const bandRight = contentX + contentW - LANE_PAD;
  const cols = Math.max(1, Math.floor((bandRight - cardX + GAP) / (CARD_W + GAP)));
  const infRows = Math.max(1, Math.ceil(inflight.value.length / cols));
  const corH1y = TOP + infRows * (CARD_H + GAP) + LANE_PAD;
  const midTop = corH1y + COR + LANE_PAD;
  const landedY = H - CARD_H - 6;
  const corH2y = landedY - LANE_PAD - COR;
  const corV2x = contentX + contentW * 0.6 - COR / 2;
  const appX = corV2x + COR;
  return { W, H, contentX, contentW, laneL, cardX, bandRight, cols, corH1y, midTop, corH2y, corV2x, appX, landedY };
});

// corridor rail centerlines
const rail = computed(() => {
  const l = L.value;
  return { xRailV: RAIL_W + COR / 2, xMidV: l.corV2x + COR / 2, yTop: l.corH1y + COR / 2, yBot: l.corH2y + COR / 2 };
});

const rects = computed<Record<string, Rect>>(() => {
  const l = L.value;
  const r: Record<string, Rect> = {};
  inflight.value.forEach((a, i) => { r[a.id] = { x: l.cardX + (i % l.cols) * (CARD_W + GAP), y: TOP + Math.floor(i / l.cols) * (CARD_H + GAP), w: CARD_W, h: CARD_H }; });
  const holdW = l.corV2x - LANE_PAD - l.cardX;
  holding.value.forEach((a, i) => { r[a.id] = { x: l.cardX, y: l.midTop + i * ROW_H, w: holdW, h: ROW_H - GAP }; });
  const appCardX = l.appX + LANE_PAD + LABEL_W + LGAP;
  const appW = l.bandRight - appCardX;
  approach.value.forEach((a, i) => { r[a.id] = { x: appCardX, y: l.midTop + i * ROW_H, w: appW, h: ROW_H - GAP }; });
  landed.value.forEach((a, i) => { r[a.id] = { x: l.cardX + i * (CARD_W + GAP), y: l.landedY, w: CARD_W, h: CARD_H }; });
  const miaCardX = LABEL_W + LGAP;
  mia.value.forEach((a, i) => { r[a.id] = { x: miaCardX, y: TOP + i * (RAIL_H + GAP), w: RAIL_W - LANE_PAD - miaCardX, h: RAIL_H }; });
  return r;
});

const zones = computed(() => {
  const l = L.value;
  const midH = l.corH2y - LANE_PAD - l.midTop;
  return [
    { k: "MIA", x: 0, y: TOP, h: l.H - TOP - 6, c: "var(--gray)" },
    { k: "In-flight", x: l.laneL, y: TOP, h: l.corH1y - LANE_PAD - TOP, c: "var(--green)" },
    { k: "Holding", x: l.laneL, y: l.midTop, h: midH, c: "var(--amber)" },
    { k: "Approach", x: l.appX + LANE_PAD, y: l.midTop, h: midH, c: "var(--blue)" },
    { k: "Landed", x: l.laneL, y: l.landedY, h: CARD_H, c: "#4cc38a" },
  ];
});

const corridors = computed(() => {
  const l = L.value;
  return [
    { x: RAIL_W, y: 0, w: COR, h: l.H },
    { x: l.contentX, y: l.corH1y, w: l.contentW, h: COR },
    { x: l.corV2x, y: l.corH1y, w: COR, h: l.corH2y + COR - l.corH1y },
    { x: l.contentX, y: l.corH2y, w: l.contentW, h: COR },
  ];
});

// solid taxiway centerlines drawn as one SVG path: the four straight rails plus
// quarter-circle fillets at each junction so turns curve instead of crossing sharply.
const taxiPath = computed(() => {
  const l = L.value;
  const g = rail.value;
  const xR = g.xRailV;
  const xM = g.xMidV;
  const yT = g.yTop;
  const yB = g.yBot;
  const right = l.contentX + l.contentW;
  const H = l.H;
  const r = Math.min(24, COR * 0.45);
  // fillet from the vertical rail to the horizontal rail in quadrant (dx,dy) of junction
  const arc = (jx: number, jy: number, dx: number, dy: number) =>
    `M ${jx} ${jy + dy * r} A ${r} ${r} 0 0 ${dx === dy ? 1 : 0} ${jx + dx * r} ${jy}`;
  return [
    `M ${xR} 0 L ${xR} ${H}`, // V-rail
    `M ${xR} ${yT} L ${right} ${yT}`, // H-top
    `M ${xM} ${yT} L ${xM} ${yB}`, // V-mid
    `M ${xR} ${yB} L ${right} ${yB}`, // H-bot
    arc(xR, yT, 1, 1), arc(xR, yT, 1, -1),
    arc(xM, yT, -1, 1), arc(xM, yT, 1, 1),
    arc(xR, yB, 1, 1), arc(xR, yB, 1, -1),
    arc(xM, yB, -1, -1), arc(xM, yB, 1, -1),
  ].join(" ");
});

const placed = computed(() => props.aircraft.filter((a) => rects.value[a.id]));

// ---- corridor router: dock each lane to its rail, shortest path over the rail graph ----
function dock(lane: Lane, r: Rect): { p: Pt; railName: string } {
  const g = rail.value;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (lane === "inflight") return { p: { x: cx, y: g.yTop }, railName: "hTop" };
  if (lane === "landed") return { p: { x: cx, y: g.yBot }, railName: "hBot" };
  if (lane === "approach") return { p: { x: g.xMidV, y: cy }, railName: "vMid" };
  return { p: { x: g.xRailV, y: cy }, railName: "vRail" }; // holding + mia dock to the V-rail
}

function routeCenters(sLane: Lane, s: Rect, dLane: Lane, d: Rect): Pt[] {
  const g = rail.value;
  const S = dock(sLane, s);
  const D = dock(dLane, d);
  const nodes: Record<string, Pt> = {
    S: S.p, D: D.p,
    TL: { x: g.xRailV, y: g.yTop }, BL: { x: g.xRailV, y: g.yBot },
    TM: { x: g.xMidV, y: g.yTop }, BM: { x: g.xMidV, y: g.yBot },
  };
  const railCorners: Record<string, string[]> = { vRail: ["TL", "BL"], vMid: ["TM", "BM"], hTop: ["TL", "TM"], hBot: ["BL", "BM"] };
  const adj: Record<string, string[]> = {};
  const edge = (a: string, b: string) => { (adj[a] ||= []).push(b); (adj[b] ||= []).push(a); };
  edge("TL", "TM"); edge("BL", "BM"); edge("TL", "BL"); edge("TM", "BM");
  for (const c of railCorners[S.railName]) edge("S", c);
  for (const c of railCorners[D.railName]) edge("D", c);
  if (S.railName === D.railName) edge("S", "D");
  const dist = (a: string, b: string) => Math.abs(nodes[a].x - nodes[b].x) + Math.abs(nodes[a].y - nodes[b].y);
  const Q = new Set(Object.keys(nodes));
  const best: Record<string, number> = {};
  const prev: Record<string, string> = {};
  for (const k of Q) best[k] = Infinity;
  best.S = 0;
  while (Q.size) {
    let u: string | null = null;
    let b = Infinity;
    for (const k of Q) if (best[k] < b) { b = best[k]; u = k; }
    if (u === null) break;
    Q.delete(u);
    if (u === "D") break;
    for (const v of adj[u] ?? []) if (Q.has(v)) { const nd = best[u] + dist(u, v); if (nd < best[v]) { best[v] = nd; prev[v] = u; } }
  }
  const via: Pt[] = [];
  let cur: string | undefined = "D";
  if (prev.D === undefined) return [S.p, D.p]; // fallback (shouldn't happen)
  while (cur) { via.unshift(nodes[cur]); if (cur === "S") break; cur = prev[cur]; }
  return via; // S.p .. corners .. D.p
}

// ---- animation --------------------------------------------------------------------
let prevRects: Record<string, Rect> = {};
let prevLane: Record<string, Lane> = {};
let prevW = 0;
let prevH = 0;

// constant travel speed: duration scales with distance (clamped), so every move looks
// like it's going the same pace regardless of how far it travels. travelMs sets the pace
// (it's the time a ~reference-length trip takes).
// near-linear in distance → CONSTANT velocity (same px/ms for short and long trips).
// travelMs sets the pace: it's the time a REF-length trip takes. Only tiny guards.
function travelDuration(dist: number): number {
  const REF = 700;
  const d = travelMs.value * (dist / REF);
  return Math.max(140, Math.min(d, travelMs.value * 3));
}

// morph (shrink/expand) time — fixed for the speed setting (distance-independent).
function morphMs(): number {
  return Math.max(220, Math.min(520, travelMs.value * 0.2));
}

// Plan a taxi as a trapezoidal-velocity move along the corridor polyline: FIXED
// acceleration `a` and cruise speed `V` (from the speed setting, NOT the distance), so
// every trip accelerates and cruises identically — short trips just cruise less (or stay
// triangular) rather than accelerating harder.
function planTaxi(sLane: Lane, from: Rect, dLane: Lane, to: Rect) {
  const via = routeCenters(sLane, from, dLane, to);
  const pts = [{ x: from.x + from.w / 2, y: from.y + from.h / 2 }, ...via, { x: to.x + to.w / 2, y: to.y + to.h / 2 }];
  const segLen: number[] = [];
  let S = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segLen.push(d); S += d; }
  const V = 700 / travelMs.value; // cruise px/ms
  const TaNom = Math.max(120, travelMs.value * 0.22); // nominal accel time
  const a = V / TaNom; // fixed acceleration
  const daFull = 0.5 * V * TaNom; // distance to reach cruise
  let Vp = V;
  let Taeff = TaNom;
  let da = daFull;
  let dc = 0;
  let Tc = 0;
  if (S >= 2 * daFull) { dc = S - 2 * daFull; Tc = dc / V; }
  else if (S > 0) { Vp = Math.sqrt(S * a); Taeff = Vp / a; da = 0.5 * Vp * Taeff; } // triangular: never reach V
  else { Taeff = 0; da = 0; }
  const T = 2 * Taeff + Tc;
  const sOf = (t: number): number => {
    if (t <= Taeff) return 0.5 * a * t * t;
    if (t <= Taeff + Tc) return da + Vp * (t - Taeff);
    const td = t - (Taeff + Tc);
    return da + dc + Vp * td - 0.5 * a * td * td;
  };
  const pointAt = (s: number) => {
    let acc = 0;
    for (let i = 0; i < segLen.length; i++) {
      const lg = segLen[i];
      if (s <= acc + lg || i === segLen.length - 1) { const f = lg > 0 ? (s - acc) / lg : 0; return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f }; }
      acc += lg;
    }
    return pts[pts.length - 1];
  };
  const timeForArc = (lq: number): number => {
    if (lq <= da) return Math.sqrt((2 * lq) / a);
    if (lq <= da + dc) return Taeff + (lq - da) / Vp;
    const rem = lq - da - dc;
    return Taeff + Tc + (Vp - Math.sqrt(Math.max(0, Vp * Vp - 2 * a * rem))) / a;
  };
  return { S, T, sOf, pointAt, firstLegDist: segLen[0] ?? 0, timeForArc };
}

// time for a departing strip to shrink AND taxi its first leg (slot → dock point), i.e.
// until it's actually out on the corridor — that's when its old lane may close the gap.
function exitClearTime(sLane: Lane, from: Rect, dLane: Lane, to: Rect): number {
  const plan = planTaxi(sLane, from, dLane, to);
  return morphMs() + plan.timeForArc(plan.firstLegDist) + 40;
}

function glide(el: HTMLElement, from: Rect, to: Rect, delay = 0): void {
  const dist = Math.hypot(to.x + to.w / 2 - (from.x + from.w / 2), to.y + to.h / 2 - (from.y + from.h / 2));
  el.animate(
    [
      { transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px` },
      { transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px` },
    ],
    // fill:"backwards" holds the strip at its OLD spot through the delay, so a gap only
    // closes once the departing strip has actually taxied out.
    { duration: travelDuration(dist), delay, easing: "cubic-bezier(.4,.05,.2,1)", fill: delay > 0 ? "backwards" : "none" },
  );
}

function puckTravel(el: HTMLElement, sLane: Lane, from: Rect, dLane: Lane, to: Rect): void {
  const plan = planTaxi(sLane, from, dLane, to);
  if (plan.S <= 0.5 || plan.T <= 1) { glide(el, from, to); return; } // degenerate → plain glide
  el.style.setProperty("--puck", LANE_COLOR[dLane] ?? "#7d8590");
  el.classList.add("traveling");

  const morph = morphMs();
  const dur = morph + plan.T + morph;
  const m1 = morph / dur;
  const m2 = (morph + plan.T) / dur;

  // 0 → m1: shrink to puck in place. m1 → m2: taxi, sampled from the trapezoidal profile
  // at uniform time steps (positions carry the fixed-accel / constant-cruise motion, so
  // linear easing between samples reproduces it). m2 → 1: expand in place.
  const kf: Keyframe[] = [{ transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px`, offset: 0, easing: "ease-in" }];
  const N = Math.max(8, Math.min(30, Math.round(plan.T / 35)));
  for (let k = 0; k <= N; k++) {
    const t = plan.T * (k / N);
    const s = Math.max(0, Math.min(plan.S, plan.sOf(t)));
    const p = plan.pointAt(s);
    kf.push({ transform: `translate(${p.x - PUCK_W / 2}px, ${p.y - PUCK_H / 2}px)`, width: `${PUCK_W}px`, height: `${PUCK_H}px`, offset: m1 + (m2 - m1) * (k / N), easing: k === N ? "ease-out" : "linear" });
  }
  kf.push({ transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px`, offset: 1 });

  const anim = el.animate(kf, { duration: dur, fill: "none" });
  anim.onfinish = () => el.classList.remove("traveling");
  anim.oncancel = () => el.classList.remove("traveling");
}

function fadeIn(el: HTMLElement): void {
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
}

function animateChanges(): void {
  const root = stage.value;
  if (!root) return;
  const cur = rects.value;
  const resized = prevW !== skyW.value || prevH !== skyH.value;
  prevW = skyW.value;
  prevH = skyH.value;

  // classify this cycle's lane changes. A lane that lost a strip only closes its gap once
  // that strip has cleared onto the taxiway (per-departure time); a lane that gained one
  // makes way immediately. Track the longest clear-time per source lane.
  const arrived = new Set<Lane>();
  const closeDelays = new Map<Lane, number>();
  for (const a of placed.value) {
    const from = prevRects[a.id];
    const to = cur[a.id];
    const pLane = prevLane[a.id];
    const lane = effectiveLane(a);
    if (from && to && pLane && pLane !== lane) {
      arrived.add(lane);
      closeDelays.set(pLane, Math.max(closeDelays.get(pLane) ?? 0, exitClearTime(pLane, from, lane, to)));
    }
  }

  for (const a of placed.value) {
    const to = cur[a.id];
    if (!to) continue;
    const el = root.querySelector<HTMLElement>(`[data-fid="${a.id}"]`);
    if (!el) continue;
    const from = prevRects[a.id];
    const lane = effectiveLane(a);
    const pLane = prevLane[a.id];
    if (!from) fadeIn(el);
    else if (resized) continue;
    else if (pLane && pLane !== lane) puckTravel(el, pLane, from, lane, to);
    else if (from.x !== to.x || from.y !== to.y || from.w !== to.w || from.h !== to.h) {
      const closing = closeDelays.has(lane) && !arrived.has(lane);
      glide(el, from, to, closing ? (closeDelays.get(lane) ?? 0) : 0);
    }
  }
  prevRects = { ...cur };
  prevLane = Object.fromEntries(placed.value.map((a) => [a.id, effectiveLane(a)]));
}
onUpdated(animateChanges);

// ---- debug actions ----------------------------------------------------------------
function cycle(id: string): void {
  const a = props.aircraft.find((x) => x.id === id);
  if (!a) return;
  const next = LANES[(LANES.indexOf(effectiveLane(a)) + 1) % LANES.length];
  override.value = { ...override.value, [id]: next };
}
function onSlotClick(id: string, e: Event): void {
  if (!props.debug) return;
  e.stopPropagation();
  e.preventDefault();
  cycle(id);
}
function step(): void {
  const list = placed.value;
  if (!list.length) return;
  const a = list[Math.floor(Math.random() * list.length)];
  const others = LANES.filter((l) => l !== effectiveLane(a));
  override.value = { ...override.value, [a.id]: others[Math.floor(Math.random() * others.length)] };
}
function shuffle(): void {
  const o: Record<string, Lane> = {};
  for (const a of props.aircraft) o[a.id] = LANES[Math.floor(Math.random() * LANES.length)];
  override.value = o;
}
function reset(): void { override.value = {}; }
</script>

<template>
  <div class="sky">
    <div ref="stage" class="stage">
    <div v-for="(c, i) in corridors" :key="'c' + i" class="corridor" :style="{ transform: `translate(${c.x}px, ${c.y}px)`, width: c.w + 'px', height: c.h + 'px' }"></div>
    <svg class="taxi-svg" :viewBox="`0 0 ${skyW} ${skyH}`" preserveAspectRatio="none"><path :d="taxiPath" /></svg>

    <div v-for="z in zones" :key="z.k" class="lane-label" :style="{ transform: `translate(${z.x}px, ${z.y}px)`, width: LABEL_W + 'px', height: z.h + 'px', color: z.c }"><span>{{ z.k }}</span></div>

    <div
      v-for="a in placed"
      :key="a.id"
      class="slot"
      :class="{ 'debug-hit': debug }"
      :data-fid="a.id"
      :style="{ transform: `translate(${rects[a.id].x}px, ${rects[a.id].y}px)`, width: rects[a.id].w + 'px', height: rects[a.id].h + 'px' }"
      @click.capture="onSlotClick(a.id, $event)"
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
      <div class="puck"><i class="ti ti-plane"></i></div>
    </div>
    </div>

    <div v-if="debug" class="dbg-bar">
      <button @click="step"><i class="ti ti-arrow-move-right"></i> Step</button>
      <button @click="shuffle"><i class="ti ti-arrows-shuffle"></i> Shuffle</button>
      <button @click="reset"><i class="ti ti-rotate"></i> Reset</button>
      <label class="dbg-speed">speed <input type="range" min="200" max="3000" step="100" v-model.number="travelMs" /> <span class="mono">{{ travelMs }}ms</span></label>
      <span class="dbg-tip">click a strip → next lane</span>
    </div>
  </div>
</template>

<style scoped>
.sky { position: relative; flex: 1; min-height: 0; overflow: hidden; margin-top: 8px; }
/* inset the whole board so lanes/taxiways get breathing room from the edges */
.stage { position: absolute; inset: 16px; }
/* taxiways: darker "asphalt" — no border/rounding so abutting corridors merge into one
   connected network; the solid yellow centreline (with curved junctions) is the SVG below */
.corridor { position: absolute; top: 0; left: 0; background: rgba(0, 0, 0, 0.22); pointer-events: none; }
.taxi-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
.taxi-svg path { fill: none; stroke: #d9a441; stroke-width: 1.5; stroke-linecap: round; opacity: 0.3; }
/* vertical lane labels in a left-side gutter (frees the vertical space top labels used) */
.lane-label { position: absolute; top: 0; left: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 3; }
.lane-label span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 10px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: currentColor; white-space: nowrap; }
.slot { position: absolute; top: 0; left: 0; overflow: hidden; z-index: 2; }
.slot.debug-hit { cursor: pointer; }
.slot :deep(.strip) { height: 100%; transition: opacity 0.18s ease; }
/* travel token: small, corridor-sized, muted target colour (not the full bright fill) */
.puck { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: color-mix(in srgb, var(--puck, #7d8590) 22%, var(--strip)); border: 1px solid color-mix(in srgb, var(--puck, #7d8590) 55%, transparent); color: color-mix(in srgb, var(--puck, #7d8590) 80%, var(--text)); font-size: 15px; opacity: 0; pointer-events: none; }
.slot.traveling { z-index: 5; }
.slot.traveling .puck { opacity: 1; }
.slot.traveling :deep(.strip) { opacity: 0; }

.dbg-bar { position: absolute; top: 0; right: 0; z-index: 6; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; background: var(--panel); border: 0.5px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
.dbg-bar button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); border: 0.5px dashed var(--border); border-radius: 6px; padding: 2px 8px; }
.dbg-bar button:hover { color: var(--text-hi); border-color: var(--gray); }
.dbg-speed { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); }
.dbg-speed input { width: 90px; }
.dbg-tip { color: var(--text-faint); }
</style>
