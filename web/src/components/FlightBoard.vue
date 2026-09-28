<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, onMounted, onUpdated, reactive, ref } from "vue";
import Strip from "./Strip.vue";
import { laneOf } from "../format";
import type { Aircraft, Lane, LanePartition } from "../types";

// Flight-layer (desktop only). One absolutely-positioned "sky" with REAL empty corridors
// between lanes. Each lane is a SCROLL container (vertical for Holding/Parked/MIA, horizontal
// for In-flight/Landed) so it holds any number of strips; the lane NAME opens a condensed grid
// of everything in it. A lane change shrinks the strip into a small target-coloured travel
// token and routes it ALONG the corridor rails into the destination lane.
//
// Because a resting strip lives inside a CLIPPED scroll container, it can't ride the open
// corridors as itself — so for the trip we LIFT it onto the stage (the `travel-layer`), taxi
// it there as the real element, then drop it back into its lane's list on arrival. The lane
// auto-scrolls to reveal the landing slot; if the pointer is over that lane (you're reading
// it) we suppress the scroll and let the strip fly in at the near edge instead.

// The taxiing token shows the Claude spark (each strip is a Claude session), tinted by the
// destination lane via currentColor.
const CLAUDE_MARK = `<svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true" style="display:block"><path fill="currentColor" d="m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6 1 3.3 2 1.9 2.7-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.3h-.8v.4l4.6 4.5 8.3 7.5L89 80.1l.5 2.4-1.3 2-1.4-.2-9.2-7-3.6-3-8-6.8h-.5v.7l1.8 2.7 9.8 14.7.5 4.5-.7 1.4-2.6 1-2.7-.6-5.8-8-6-9-4.7-8.2-.5.4-2.9 30.2-1.3 1.5-3 1.2-2.5-2-1.4-3 1.4-6.2 1.6-8 1.3-6.4 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z"/></svg>`;

const props = defineProps<{ lanes: LanePartition; now: number; debug?: boolean }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
  open: [id: string];
  dbgCycle: [id: string];
  dbgStep: [];
  dbgShuffle: [];
  dbgReset: [];
}>();

const LANE_COLOR: Record<string, string> = { inflight: "#3fb950", holding: "#e0a92e", parked: "#e0823c", landed: "#4cc38a", mia: "#7d8590", cold: "#4d5560" };
const LANE_KEYS = ["inflight", "holding", "parked", "landed", "mia"] as const;

// lanes are partitioned + sorted once by App and shared as a prop (no re-derivation here)
const inflight = computed(() => props.lanes.inflight);
const holding = computed(() => props.lanes.holding);
const parked = computed(() => props.lanes.parked);
const landed = computed(() => props.lanes.landed);
const mia = computed(() => props.lanes.mia);
const listMap = { inflight, holding, parked, landed, mia };
const listFor = (k: Lane) => listMap[k as keyof typeof listMap];
const allAircraft = computed(() => [...inflight.value, ...holding.value, ...parked.value, ...landed.value, ...mia.value]);

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
  void nextTick(refreshFades);
});
onBeforeUnmount(() => ro?.disconnect());

const travelMs = ref(800);

// geometry (fixed, desktop)
const GAP = 8; // gap between strips within a lane
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
type Axis = "x" | "y";

const L = computed(() => {
  const W = skyW.value;
  const H = skyH.value;
  const contentX = RAIL_W + COR;
  const contentW = Math.max(360, W - contentX);
  const laneL = contentX + LANE_PAD;
  const cardX = laneL + LABEL_W + LGAP;
  const bandRight = contentX + contentW - LANE_PAD;
  const corH1y = TOP + (CARD_H + GAP) + LANE_PAD; // In-flight is a single (horizontally scrolling) row
  const midTop = corH1y + COR + LANE_PAD;
  const landedY = H - CARD_H - 6;
  const corH2y = landedY - LANE_PAD - COR;
  const corV2x = contentX + contentW * 0.6 - COR / 2;
  const appX = corV2x + COR;
  const appCardX = appX + LANE_PAD + LABEL_W + LGAP;
  const miaCardX = LABEL_W + LGAP;
  return { W, H, contentX, contentW, laneL, cardX, bandRight, corH1y, midTop, corH2y, corV2x, appX, appCardX, miaCardX, landedY };
});

// each lane's scroll container box (stage coords) + its scroll axis
const bands = computed<Record<string, Rect & { axis: Axis }>>(() => {
  const l = L.value;
  const midH = l.corH2y - LANE_PAD - l.midTop;
  return {
    inflight: { x: l.cardX, y: TOP, w: l.bandRight - l.cardX, h: CARD_H, axis: "x" },
    holding: { x: l.cardX, y: l.midTop, w: l.corV2x - LANE_PAD - l.cardX, h: midH, axis: "y" },
    parked: { x: l.appCardX, y: l.midTop, w: l.bandRight - l.appCardX, h: midH, axis: "y" },
    landed: { x: l.cardX, y: l.landedY, w: l.bandRight - l.cardX, h: CARD_H, axis: "x" },
    mia: { x: l.miaCardX, y: TOP, w: RAIL_W - LANE_PAD - l.miaCardX, h: l.H - TOP - 6, axis: "y" },
  };
});

// strip rects in container-LOCAL coords (x=0 for vertical lanes, y=0 for horizontal ones)
const rects = computed<Record<string, Rect>>(() => {
  const r: Record<string, Rect> = {};
  const b = bands.value;
  inflight.value.forEach((a, i) => { r[a.id] = { x: i * (CARD_W + GAP), y: 0, w: CARD_W, h: CARD_H }; });
  holding.value.forEach((a, i) => { r[a.id] = { x: 0, y: i * ROW_H, w: b.holding.w, h: ROW_H - GAP }; });
  parked.value.forEach((a, i) => { r[a.id] = { x: 0, y: i * ROW_H, w: b.parked.w, h: ROW_H - GAP }; });
  landed.value.forEach((a, i) => { r[a.id] = { x: i * (CARD_W + GAP), y: 0, w: CARD_W, h: CARD_H }; });
  mia.value.forEach((a, i) => { r[a.id] = { x: 0, y: i * (RAIL_H + GAP), w: b.mia.w, h: RAIL_H }; });
  return r;
});

// scroll-content extent per lane (grows along the scroll axis with the strip count)
const laneContent = computed<Record<string, Rect>>(() => {
  const b = bands.value;
  const ext = (lane: Lane, along: number) => (b[lane].axis === "y" ? { x: 0, y: 0, w: b[lane].w, h: along } : { x: 0, y: 0, w: along, h: b[lane].h });
  return {
    inflight: ext("inflight", inflight.value.length * (CARD_W + GAP)),
    holding: ext("holding", holding.value.length * ROW_H),
    parked: ext("parked", parked.value.length * ROW_H),
    landed: ext("landed", landed.value.length * (CARD_W + GAP)),
    mia: ext("mia", mia.value.length * (RAIL_H + GAP)),
  };
});

// live scroll containers, wired via function refs in the template
const laneEls = reactive<Record<string, HTMLElement | null>>({ inflight: null, holding: null, parked: null, landed: null, mia: null });
const setLaneEl = (lane: Lane) => (el: unknown) => { laneEls[lane] = el instanceof HTMLElement ? el : null; };
const laneScroll = (lane: Lane): Pt => { const el = laneEls[lane]; return { x: el?.scrollLeft ?? 0, y: el?.scrollTop ?? 0 }; };

// map a lane's LOCAL rect to on-screen STAGE coords (accounting for that lane's scroll)
function stageRect(lane: Lane, r: Rect, scroll?: Pt): Rect {
  const b = bands.value[lane];
  const s = scroll ?? laneScroll(lane);
  return { x: b.x + r.x - s.x, y: b.y + r.y - s.y, w: r.w, h: r.h };
}

// ---- travel layer: strips lifted onto the stage while taxiing between lanes ----
const traveling = reactive(new Set<string>());
const travelDest = reactive<Record<string, Rect>>({}); // resting stage rect while lifted
const laneItems = computed<Record<string, Aircraft[]>>(() => {
  const pick = (arr: Aircraft[]) => arr.filter((a) => rects.value[a.id] && !traveling.has(a.id));
  return { inflight: pick(inflight.value), holding: pick(holding.value), parked: pick(parked.value), landed: pick(landed.value), mia: pick(mia.value) };
});
const travelItems = computed(() => allAircraft.value.filter((a) => traveling.has(a.id)));

// pointer-over-lane: while you're reading a lane we don't yank its scroll (see animateChanges)
const hoverLane = ref<Lane | null>(null);

// Edge fade: fade the lane's content to transparent on any edge that has more to scroll to —
// a soft hint that the lane continues. Applied imperatively (a CSS mask) so a scroll doesn't
// trigger a Vue re-render. Refreshed on scroll and whenever content/size changes.
const FADE_PX = 26;
function updateFade(lane: Lane): void {
  const el = laneEls[lane];
  if (!el) return;
  const horizontal = bands.value[lane].axis === "x";
  const pos = horizontal ? el.scrollLeft : el.scrollTop;
  const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  const s = pos > 1 ? FADE_PX : 0;
  const e = pos < max - 1 ? FADE_PX : 0;
  const mask = s || e ? `linear-gradient(${horizontal ? "to right" : "to bottom"}, transparent 0, #000 ${s}px, #000 calc(100% - ${e}px), transparent 100%)` : "";
  el.style.webkitMaskImage = mask;
  el.style.maskImage = mask;
}
function refreshFades(): void { for (const k of LANE_KEYS) updateFade(k); }

// Horizontal lanes (In-flight/Landed): translate a plain vertical wheel into horizontal scroll
// so you don't have to hold Shift. Vertical lanes keep native wheel behaviour.
function onLaneWheel(lane: Lane, e: WheelEvent): void {
  if (bands.value[lane].axis !== "x") return;
  const el = laneEls[lane];
  if (!el || el.scrollWidth <= el.clientWidth) return;
  const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  if (!raw) return;
  const mult = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1;
  el.scrollLeft += raw * mult;
  e.preventDefault();
}

// A move YOU triggered (land / unland / note) shouldn't make the destination lane auto-scroll
// to chase the strip — you were looking at it where it was. We flag such ids so animateChanges
// suppresses the reveal-scroll for them (autonomous state-change arrivals still reveal).
const userMoved = new Set<string>();
const noteUserMove = (id: string) => { userMoved.add(id); setTimeout(() => userMoved.delete(id), 2500); };
const onLand = (id: string) => { noteUserMove(id); emit("land", id); };
const onUnland = (id: string) => { noteUserMove(id); emit("unland", id); };
const onSetNote = (id: string, n: string) => { noteUserMove(id); emit("setNote", id, n); };
const onRemoveNote = (id: string) => { noteUserMove(id); emit("removeNote", id); };

// ---- overview grid: clicking a lane's NAME opens a condensed grid of everything in it ----
const openGrid = ref<Lane | null>(null);
const gridItems = computed<Aircraft[]>(() => (openGrid.value ? listFor(openGrid.value).value : []));

const rectStyle = (r?: Rect) => (r ? { transform: `translate(${r.x}px, ${r.y}px)`, width: r.w + "px", height: r.h + "px" } : { display: "none" });
const laneBoxStyle = (lane: Lane) => {
  const b = bands.value[lane];
  const scrollX = (b.axis === "x" ? "auto" : "hidden") as "auto" | "hidden";
  const scrollY = (b.axis === "y" ? "auto" : "hidden") as "auto" | "hidden";
  return { transform: `translate(${b.x}px, ${b.y}px)`, width: b.w + "px", height: b.h + "px", overflowX: scrollX, overflowY: scrollY };
};
const laneContentStyle = (lane: Lane) => { const c = laneContent.value[lane]; return { width: c.w + "px", height: c.h + "px" }; };

const zones = computed(() => {
  const l = L.value;
  const midH = l.corH2y - LANE_PAD - l.midTop;
  return [
    { lane: "mia" as Lane, k: "MIA", x: 0, y: TOP, h: l.H - TOP - 6, c: "var(--gray)" },
    { lane: "inflight" as Lane, k: "In-flight", x: l.laneL, y: TOP, h: l.corH1y - LANE_PAD - TOP, c: "var(--green)" },
    { lane: "holding" as Lane, k: "Holding", x: l.laneL, y: l.midTop, h: midH, c: "var(--amber)" },
    { lane: "parked" as Lane, k: "Parked", x: l.appX + LANE_PAD, y: l.midTop, h: midH, c: "var(--parked)" },
    { lane: "landed" as Lane, k: "Landed", x: l.laneL, y: l.landedY, h: CARD_H, c: "#4cc38a" },
  ];
});

// corridor rail centerlines
const rail = computed(() => {
  const l = L.value;
  return { xRailV: RAIL_W + COR / 2, xMidV: l.corV2x + COR / 2, yTop: l.corH1y + COR / 2, yBot: l.corH2y + COR / 2 };
});

const corridors = computed(() => {
  const l = L.value;
  const R = 14;
  return [
    { x: RAIL_W, y: 0, w: COR, h: l.H, radius: `${R}px` },
    { x: l.contentX, y: l.corH1y, w: l.contentW, h: COR, radius: `0 ${R}px ${R}px 0` },
    { x: l.corV2x, y: l.corH1y, w: COR, h: l.corH2y + COR - l.corH1y, radius: "0" },
    { x: l.contentX, y: l.corH2y, w: l.contentW, h: COR, radius: `0 ${R}px ${R}px 0` },
  ];
});

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
  const STOP = 16;
  const CB = 11;
  const arc = (jx: number, jy: number, dx: number, dy: number) =>
    `M ${jx} ${jy + dy * r} A ${r} ${r} 0 0 ${dx === dy ? 1 : 0} ${jx + dx * r} ${jy}`;
  return [
    `M ${xR} ${STOP} L ${xR} ${H - STOP}`,
    `M ${xR + r} ${yT} L ${right - STOP} ${yT}`,
    `M ${xM} ${yT + r} L ${xM} ${yB - r}`,
    `M ${xR + r} ${yB} L ${right - STOP} ${yB}`,
    arc(xR, yT, 1, 1), arc(xR, yT, 1, -1),
    arc(xM, yT, -1, 1), arc(xM, yT, 1, 1),
    arc(xR, yB, 1, 1), arc(xR, yB, 1, -1),
    arc(xM, yB, -1, -1), arc(xM, yB, 1, -1),
    `M ${xR - CB} ${STOP} L ${xR + CB} ${STOP}`,
    `M ${xR - CB} ${H - STOP} L ${xR + CB} ${H - STOP}`,
    `M ${right - STOP} ${yT - CB} L ${right - STOP} ${yT + CB}`,
    `M ${right - STOP} ${yB - CB} L ${right - STOP} ${yB + CB}`,
  ].join(" ");
});

// ---- corridor router: dock each lane to its rail, shortest path over the rail graph ----
function dock(lane: Lane, r: Rect): { p: Pt; railName: string } {
  const g = rail.value;
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  if (lane === "inflight") return { p: { x: cx, y: g.yTop }, railName: "hTop" };
  if (lane === "landed") return { p: { x: cx, y: g.yBot }, railName: "hBot" };
  if (lane === "parked") return { p: { x: g.xMidV, y: cy }, railName: "vMid" };
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
  if (prev.D === undefined) return [S.p, D.p];
  while (cur) { via.unshift(nodes[cur]); if (cur === "S") break; cur = prev[cur]; }
  return via;
}

// ---- animation --------------------------------------------------------------------
let prevRects: Record<string, Rect> = {};
let prevLane: Record<string, Lane> = {};
let prevW = 0;
let prevH = 0;
let lastAnimSig = "";

// the along-axis stride between consecutive slots in a lane
function laneStep(lane: Lane): number {
  if (lane === "inflight" || lane === "landed") return CARD_W + GAP;
  if (lane === "mia") return RAIL_H + GAP;
  return ROW_H; // holding, parked
}

// Snapshot each lane's scroll BEFORE every re-render. When a strip then leaves a lane, its
// content shrinks and the strips after it reflow toward the origin — left unchecked the browser
// leaves scroll where it was (or clamps it), so the viewport appears to jump. We use this
// snapshot in animateChanges to re-anchor the source lane so the remaining strips stay put.
let scrollSnap: Record<string, Pt> = {};
onBeforeUpdate(() => {
  const snap: Record<string, Pt> = {};
  for (const k of LANE_KEYS) { const el = laneEls[k]; snap[k] = { x: el?.scrollLeft ?? 0, y: el?.scrollTop ?? 0 }; }
  scrollSnap = snap;
});

function travelDuration(dist: number): number {
  const REF = 700;
  const d = travelMs.value * (dist / REF);
  return Math.max(140, Math.min(d, travelMs.value * 3));
}

function morphMs(): number {
  return Math.max(220, Math.min(520, travelMs.value * 0.2));
}

function planTaxi(sLane: Lane, from: Rect, dLane: Lane, to: Rect) {
  const via = routeCenters(sLane, from, dLane, to);
  const pts = [{ x: from.x + from.w / 2, y: from.y + from.h / 2 }, ...via, { x: to.x + to.w / 2, y: to.y + to.h / 2 }];
  const segLen: number[] = [];
  let S = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); segLen.push(d); S += d; }
  const V = 700 / travelMs.value;
  const TaNom = Math.max(120, travelMs.value * 0.22);
  const a = V / TaNom;
  const daFull = 0.5 * V * TaNom;
  let Vp = V;
  let Taeff = TaNom;
  let da = daFull;
  let dc = 0;
  let Tc = 0;
  if (S >= 2 * daFull) { dc = S - 2 * daFull; Tc = dc / V; }
  else if (S > 0) { Vp = Math.sqrt(S * a); Taeff = Vp / a; da = 0.5 * Vp * Taeff; }
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
    { duration: travelDuration(dist), delay, easing: "cubic-bezier(.4,.05,.2,1)", fill: delay > 0 ? "backwards" : "none" },
  );
}

// Taxi a strip along the corridors in STAGE coords. `el` is the lifted travel-layer element;
// it shrinks to a puck, rides the rails, expands at `to`, then `onDone` drops it back into
// its lane's list. Same trapezoidal-velocity profile as before — the beloved slide, intact.
function puckTravel(el: HTMLElement, sLane: Lane, from: Rect, dLane: Lane, to: Rect, onDone: () => void): void {
  const plan = planTaxi(sLane, from, dLane, to);
  if (plan.S <= 0.5 || plan.T <= 1) { glide(el, from, to); onDone(); return; }
  el.style.setProperty("--puck", LANE_COLOR[dLane] ?? "#7d8590");
  el.classList.add("traveling");

  const morph = morphMs();
  const dur = morph + plan.T + morph;
  const m1 = morph / dur;
  const m2 = (morph + plan.T) / dur;

  const kf: Keyframe[] = [{ transform: `translate(${from.x}px, ${from.y}px)`, width: `${from.w}px`, height: `${from.h}px`, offset: 0, easing: "ease-in" }];
  const N = Math.max(8, Math.min(30, Math.round(plan.T / 35)));
  for (let k = 0; k <= N; k++) {
    const t = plan.T * (k / N);
    const s = Math.max(0, Math.min(plan.S, plan.sOf(t)));
    const p = plan.pointAt(s);
    kf.push({ transform: `translate(${p.x - PUCK_W / 2}px, ${p.y - PUCK_H / 2}px)`, width: `${PUCK_W}px`, height: `${PUCK_H}px`, offset: m1 + (m2 - m1) * (k / N), easing: k === N ? "ease-out" : "linear" });
  }
  kf.push({ transform: `translate(${to.x}px, ${to.y}px)`, width: `${to.w}px`, height: `${to.h}px`, offset: 1 });

  const anim = el.animate(kf, { duration: dur, fill: "forwards" });
  const fin = () => { el.classList.remove("traveling"); onDone(); };
  anim.onfinish = fin;
  anim.oncancel = fin;
}

function fadeIn(el: HTMLElement): void {
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: "ease-out" });
}

// minimal scroll (in a lane's axis) that brings a local slot fully into the visible band
function revealScroll(lane: Lane, to: Rect): Pt {
  const el = laneEls[lane];
  const b = bands.value[lane];
  const c = laneContent.value[lane];
  const cur = laneScroll(lane);
  if (!el) return cur;
  if (b.axis === "y") {
    const client = el.clientHeight;
    let y = cur.y;
    if (to.y < cur.y) y = to.y;
    else if (to.y + to.h > cur.y + client) y = to.y + to.h - client;
    return { x: 0, y: Math.max(0, Math.min(y, Math.max(0, c.h - client))) };
  }
  const client = el.clientWidth;
  let x = cur.x;
  if (to.x < cur.x) x = to.x;
  else if (to.x + to.w > cur.x + client) x = to.x + to.w - client;
  return { x: Math.max(0, Math.min(x, Math.max(0, c.w - client))), y: 0 };
}

function scrollLaneTo(lane: Lane, s: Pt): void {
  laneEls[lane]?.scrollTo({ left: s.x, top: s.y, behavior: "smooth" });
}

// keep a stage rect inside a lane's band (used for the hover case: land at the near edge)
function clampToBand(r: Rect, lane: Lane): Rect {
  const b = bands.value[lane];
  return {
    x: Math.max(b.x, Math.min(r.x, b.x + b.w - r.w)),
    y: Math.max(b.y, Math.min(r.y, b.y + b.h - r.h)),
    w: r.w,
    h: r.h,
  };
}

// is a local slot currently within the lane's visible band (no scroll needed)?
function slotVisible(lane: Lane, to: Rect): boolean {
  const el = laneEls[lane];
  if (!el) return true;
  const b = bands.value[lane];
  const s = laneScroll(lane);
  return b.axis === "y" ? to.y >= s.y && to.y + to.h <= s.y + el.clientHeight : to.x >= s.x && to.x + to.w <= s.x + el.clientWidth;
}

async function animateChanges(): Promise<void> {
  const root = stage.value;
  if (!root) return;
  const cur = rects.value;
  // The 1s clock tick re-renders us; skip the whole pass unless a strip's lane/slot changed.
  // (Scroll position deliberately isn't in the signature — scrolling must not trigger a pass.)
  const sig =
    `${skyW.value}x${skyH.value}|` +
    LANE_KEYS.map((k) => `${k}:` + listFor(k).value.map((a) => `${a.id}@${cur[a.id]?.x},${cur[a.id]?.y}`).join(",")).join(";");
  if (sig === lastAnimSig) return;
  lastAnimSig = sig;

  const resized = prevW !== skyW.value || prevH !== skyH.value;
  prevW = skyW.value;
  prevH = skyH.value;

  const all = allAircraft.value;

  // lane changes (movers) — collected first so we can time source-lane gap-closes
  const moves: { id: string; from: Rect; to: Rect; pLane: Lane; lane: Lane }[] = [];
  for (const a of all) {
    const to = cur[a.id];
    const from = prevRects[a.id];
    const pLane = prevLane[a.id];
    const lane = laneOf(a);
    if (to && from && pLane && pLane !== lane) moves.push({ id: a.id, from, to, pLane, lane });
  }
  const arrived = new Set<Lane>();
  const closeDelays = new Map<Lane, number>();
  for (const m of moves) {
    arrived.add(m.lane);
    closeDelays.set(m.pLane, Math.max(closeDelays.get(m.pLane) ?? 0, exitClearTime(m.pLane, stageRect(m.pLane, m.from), m.lane, stageRect(m.lane, m.to))));
  }

  // Re-anchor each SOURCE lane so removing a strip doesn't make the viewport jump. Strips after
  // the departed one reflow toward the origin by one stride; we shift the lane's scroll back by
  // one stride per strip that left from before the viewport (clamped to the new extent) so the
  // remaining strips stay visually put. Runs in onUpdated (post-patch, pre-paint) → never seen.
  // A re-anchored lane's reflow must SNAP (not glide): gliding while the scroll jumps back would
  // make those strips hop a stride and slide back. With both instant, the view is perfectly still.
  const reanchored = new Set<Lane>();
  const bySrc = new Map<Lane, typeof moves>();
  for (const m of moves) { const g = bySrc.get(m.pLane) ?? []; g.push(m); bySrc.set(m.pLane, g); }
  for (const [lane, ms] of bySrc) {
    const el = laneEls[lane];
    if (!el) continue;
    const axis = bands.value[lane].axis;
    const step = laneStep(lane);
    const sPre = axis === "y" ? scrollSnap[lane]?.y ?? 0 : scrollSnap[lane]?.x ?? 0;
    let removedBefore = 0;
    for (const m of ms) { if ((axis === "y" ? m.from.y : m.from.x) < sPre) removedBefore++; }
    if (removedBefore === 0) continue; // nothing left of the viewport → normal glide is fine
    const c = laneContent.value[lane];
    const max = axis === "y" ? Math.max(0, c.h - el.clientHeight) : Math.max(0, c.w - el.clientWidth);
    const target = Math.max(0, Math.min(sPre - removedBefore * step, max));
    if (axis === "y") el.scrollTop = target; else el.scrollLeft = target;
    reanchored.add(lane);
  }

  // within-lane reflow + fresh enters (on the resting container elements)
  for (const a of all) {
    const to = cur[a.id];
    if (!to) continue;
    const from = prevRects[a.id];
    const lane = laneOf(a);
    const pLane = prevLane[a.id];
    if (from && pLane && pLane !== lane) continue; // mover → handled below
    const el = root.querySelector<HTMLElement>(`.lane-scroll [data-fid="${a.id}"]`);
    if (!el) continue;
    if (!from) {
      if (!resized) fadeIn(el);
    } else if (resized || reanchored.has(lane)) {
      continue; // re-anchored → snap to the new slot so the compensated scroll stays still
    } else if (from.x !== to.x || from.y !== to.y || from.w !== to.w || from.h !== to.h) {
      const closing = closeDelays.has(lane) && !arrived.has(lane);
      glide(el, from, to, closing ? (closeDelays.get(lane) ?? 0) : 0);
    }
  }

  // movers: lift onto the stage, auto-scroll the destination to reveal the slot (unless the
  // pointer is over that lane), taxi as the real element, then drop back into the list.
  if (moves.length) {
    for (const m of moves) {
      // suppress the reveal-scroll when you're reading the destination lane, or when YOU
      // triggered this move (land/unland/note) — don't yank the view to chase the strip.
      const suppress = hoverLane.value === m.lane || userMoved.has(m.id);
      userMoved.delete(m.id);
      if (suppress) {
        // land at the real slot if it's already visible, else fly in at the near edge and
        // let the list absorb it — the scroll position stays put.
        travelDest[m.id] = slotVisible(m.lane, m.to) ? stageRect(m.lane, m.to) : clampToBand(stageRect(m.lane, m.to), m.lane);
      } else {
        const finalScroll = revealScroll(m.lane, m.to);
        travelDest[m.id] = stageRect(m.lane, m.to, finalScroll);
        scrollLaneTo(m.lane, finalScroll);
      }
      traveling.add(m.id);
    }
    await nextTick();
    for (const m of moves) {
      const el = root.querySelector<HTMLElement>(`.travel-layer [data-fid="${m.id}"]`);
      const done = () => { traveling.delete(m.id); delete travelDest[m.id]; };
      if (!el) { done(); continue; }
      puckTravel(el, m.pLane, stageRect(m.pLane, m.from), m.lane, travelDest[m.id], done);
    }
  }

  prevRects = { ...cur };
  prevLane = Object.fromEntries(all.map((a) => [a.id, laneOf(a)])) as Record<string, Lane>;
  refreshFades(); // content/size may have changed which edges overflow
}
onUpdated(() => { void animateChanges(); });

// ---- debug actions ----------------------------------------------------------------
function onSlotClick(id: string, e: Event): void {
  if (!props.debug) return;
  e.stopPropagation();
  e.preventDefault();
  emit("dbgCycle", id);
}
</script>

<template>
  <div class="sky">
    <div ref="stage" class="stage">
    <div v-for="(c, i) in corridors" :key="'c' + i" class="corridor" :style="{ transform: `translate(${c.x}px, ${c.y}px)`, width: c.w + 'px', height: c.h + 'px', borderRadius: c.radius }"></div>
    <svg class="taxi-svg" :viewBox="`0 0 ${skyW} ${skyH}`" preserveAspectRatio="none"><path :d="taxiPath" /></svg>

    <button v-for="z in zones" :key="z.k" class="lane-label" :style="{ transform: `translate(${z.x}px, ${z.y}px)`, width: LABEL_W + 'px', height: z.h + 'px', color: z.c }" :title="`Open ${z.k} grid`" @click="openGrid = z.lane"><span>{{ z.k }}</span></button>

    <!-- resting strips: each lane is a clipped scroll container; strips inside use local coords -->
    <div
      v-for="lane in LANE_KEYS"
      :key="lane"
      class="lane-scroll"
      :ref="setLaneEl(lane)"
      :style="laneBoxStyle(lane)"
      @wheel="onLaneWheel(lane, $event)"
      @scroll="updateFade(lane)"
      @mouseenter="hoverLane = lane"
      @mouseleave="hoverLane === lane && (hoverLane = null)"
    >
      <div class="lane-content" :style="laneContentStyle(lane)">
        <div
          v-for="a in laneItems[lane]"
          :key="a.id"
          class="slot"
          :class="{ 'debug-hit': debug }"
          :data-fid="a.id"
          :style="rectStyle(rects[a.id])"
          @click.capture="onSlotClick(a.id, $event)"
        >
          <Strip
            :aircraft="a"
            :now="now"
            @set-note="onSetNote"
            @remove-note="onRemoveNote"
            @land="onLand"
            @unland="onUnland"
            @open="(id) => emit('open', id)"
          />
          <div class="puck" v-html="CLAUDE_MARK"></div>
        </div>
      </div>
    </div>

    <!-- travel layer: strips lifted onto the open stage while taxiing between lanes -->
    <div class="travel-layer">
      <div v-for="a in travelItems" :key="a.id" class="slot" :data-fid="a.id" :style="rectStyle(travelDest[a.id])">
        <Strip
          :aircraft="a"
          :now="now"
          @set-note="onSetNote"
          @remove-note="onRemoveNote"
          @land="onLand"
          @unland="onUnland"
          @open="(id) => emit('open', id)"
        />
        <div class="puck" v-html="CLAUDE_MARK"></div>
      </div>
    </div>
    </div>

    <div v-if="openGrid && gridItems.length" class="drawer-overlay" @click.self="openGrid = null">
      <div class="drawer-panel">
        <div class="drawer-panel-h">
          <span><i class="ti ti-layers-subtract"></i> {{ zones.find((z) => z.lane === openGrid)?.k ?? openGrid }} — {{ gridItems.length }}</span>
          <button class="icon" aria-label="close" @click="openGrid = null"><i class="ti ti-x"></i></button>
        </div>
        <div class="drawer-panel-grid">
          <Strip
            v-for="a in gridItems"
            :key="a.id"
            :aircraft="a"
            :now="now"
            @set-note="onSetNote"
            @remove-note="onRemoveNote"
            @land="onLand"
            @unland="onUnland"
            @open="(id) => emit('open', id)"
          />
        </div>
      </div>
    </div>

    <div v-if="debug" class="dbg-bar">
      <button @click="emit('dbgStep')"><i class="ti ti-arrow-move-right"></i> Step</button>
      <button @click="emit('dbgShuffle')"><i class="ti ti-arrows-shuffle"></i> Shuffle</button>
      <button @click="emit('dbgReset')"><i class="ti ti-rotate"></i> Reset</button>
      <label class="dbg-speed">speed <input type="range" min="200" max="3000" step="100" v-model.number="travelMs" /> <span class="mono">{{ travelMs }}ms</span></label>
      <span class="dbg-tip">click a strip → next lane</span>
    </div>
  </div>
</template>

<style scoped>
.sky { position: relative; flex: 1; min-height: 0; overflow: hidden; margin-top: 8px; }
.stage { position: absolute; inset: 16px; }
.corridor { position: absolute; top: 0; left: 0; background: #090c11; pointer-events: none; }
.taxi-svg { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
.taxi-svg path { fill: none; stroke: #d9a441; stroke-width: 1.5; stroke-linecap: round; opacity: 0.3; }
/* lane names double as the "open grid" control */
.lane-label { all: unset; position: absolute; top: 0; left: 0; display: flex; align-items: center; justify-content: center; z-index: 3; cursor: pointer; box-sizing: border-box; }
.lane-label span { writing-mode: vertical-rl; transform: rotate(180deg); font-size: 10px; font-weight: 600; letter-spacing: 1.5px; text-transform: uppercase; color: currentColor; white-space: nowrap; opacity: 0.85; transition: opacity 0.15s ease; }
.lane-label:hover span { opacity: 1; text-decoration: underline; }
/* each lane is a clipping scroll container. Scrollbars are HIDDEN (not just thin): a classic
   space-taking bar — which non-overlay platforms always render — eats into the fixed card
   height/width and clips the strips. Scroll still works by wheel/trackpad; the lane name opens
   the full grid as the "see everything" backup. */
.lane-scroll { position: absolute; top: 0; left: 0; z-index: 2; overscroll-behavior: contain; scrollbar-width: none; -ms-overflow-style: none; }
.lane-scroll::-webkit-scrollbar { width: 0; height: 0; display: none; }
.lane-content { position: relative; }
.slot { position: absolute; top: 0; left: 0; overflow: hidden; z-index: 2; }
.slot.debug-hit { cursor: pointer; }
.slot :deep(.strip) { height: 100%; transition: opacity 0.18s ease; }
/* travel layer sits above the resting lanes so a taxiing strip crosses over them + the corridors */
.travel-layer { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
.travel-layer .slot { overflow: visible; }
.puck { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; border-radius: 8px; background: color-mix(in srgb, var(--puck, #7d8590) 22%, var(--strip)); border: 1px solid color-mix(in srgb, var(--puck, #7d8590) 55%, transparent); color: color-mix(in srgb, var(--puck, #7d8590) 80%, var(--text)); font-size: 15px; opacity: 0; pointer-events: none; }
.slot.traveling { z-index: 5; }
.slot.traveling .puck { opacity: 1; }
.slot.traveling :deep(.strip) { opacity: 0; }

/* lane overview grid (opened from a lane name) */
.drawer-overlay { position: absolute; inset: 0; z-index: 40; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 28px; }
.drawer-panel { width: min(1100px, 92%); max-height: 84%; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.drawer-panel-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 500; color: var(--text); text-transform: capitalize; }
.drawer-panel-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.drawer-panel-h .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.drawer-panel-grid { flex: 1; min-height: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); grid-auto-rows: 132px; gap: 8px; padding: 12px 14px; align-content: start; }

.dbg-bar { position: absolute; top: 0; right: 0; z-index: 6; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; justify-content: flex-end; background: var(--panel); border: 0.5px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 12px; }
.dbg-bar button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; color: var(--text-dim); border: 0.5px dashed var(--border); border-radius: 6px; padding: 2px 8px; }
.dbg-bar button:hover { color: var(--text-hi); border-color: var(--gray); }
.dbg-speed { display: inline-flex; align-items: center; gap: 6px; color: var(--text-dim); }
.dbg-speed input { width: 90px; }
.dbg-tip { color: var(--text-faint); }
</style>
