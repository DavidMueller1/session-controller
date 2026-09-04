<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";

// Easter egg: soft smoke drifting over the whole screen that parts around the cursor.
// A curl-noise flow field advects a few thousand light particles — the curl (a
// divergence-free field) is what makes them read as turbulent, wispy smoke instead of dots.
// The cursor injects a local push + swirl + a decaying wake impulse, so the haze curls
// around the pointer and trails off it. Full-viewport, pointer-events:none, so the app
// underneath stays fully visible and clickable. Self-contained — touches no board state,
// and fully tears down (RAF + canvas + listeners) on unmount, so there's zero cost when off.

// `active` drives the fade: true = form in, false = dissipate out. The parent keeps us
// mounted through the outro and unmounts only when we emit `faded` (fully gone → teardown).
const props = defineProps<{ active?: boolean }>();
const emit = defineEmits<{ faded: [] }>();

const canvas = ref<HTMLCanvasElement | null>(null);
const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// --- feel knobs (all tunable) ------------------------------------------------------------
const FREQ = 0.004; // spatial scale of the swirls (smaller = broader, lazier eddies)
const FLOW = 28; // base drift speed along the field (px/s)
const DRIFT_Y = -8; // gentle overall rise (px/s), like warm smoke
const FIELD_EVO = 0.05; // how fast the field itself churns over time
const R = 150; // cursor influence radius (px)
const PUSH = 1500; // radial shove out of the cursor
const SWIRL = 1000; // tangential spin around the cursor
const WAKE = 1.1; // how much of the pointer's own motion the smoke inherits (trailing wake)
const IMP_DRAG = 2.0; // how fast a mouse impulse bleeds off (higher = shorter trails)
const SIZE_MIN = 120, SIZE_MAX = 320; // puff diameters (px) — big & overlapping = cloud, not dust
const ALPHA_MIN = 0.07, ALPHA_MAX = 0.18; // per-puff opacity (additive, so overlaps build up)
const LIFE_MIN = 9, LIFE_MAX = 22; // seconds before a puff recycles (fades in/out over life)
const FADE = 2.0; // seconds to form in / dissipate out (opacity + size bloom, both directions)
// large-scale density mask: a slow, low-frequency noise carves the even haze into billowing
// cloud BANKS with clear sky between them — the difference between "clouds" and "uniform fog".
const MASK_FREQ = 0.0026; // bigger = smaller, more frequent banks (a few across the screen)
const MASK_FLOOR = 0.18, MASK_SPAN = 0.30; // below floor = clear sky; floor+span = solid cloud
// -----------------------------------------------------------------------------------------

let raf = 0;

onMounted(() => {
  if (reduce) {
    // reduced-motion: no clouds at all — but still resolve the outro so the parent unmounts
    watch(() => props.active, (a) => { if (!a) emit("faded"); });
    return;
  }
  const cv = canvas.value!;
  const ctx = cv.getContext("2d", { alpha: true })!;
  let W = 0, H = 0;

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + "px"; cv.style.height = H + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();

  // Soft round puff sprite (blurred radial gradient), pre-rendered ONCE and stamped per
  // particle — far cheaper than per-frame gradients. Cool blue-white to sit on the dark UI.
  const SPR = 128;
  const sprite = document.createElement("canvas");
  sprite.width = sprite.height = SPR;
  const sctx = sprite.getContext("2d")!;
  // soft blue-grey (NOT near-white) so even fully-stacked clouds saturate to a muted cloud
  // tone rather than blowing out — the tone is the brightness ceiling, so there's no glare.
  const g = sctx.createRadialGradient(SPR / 2, SPR / 2, 0, SPR / 2, SPR / 2, SPR / 2);
  g.addColorStop(0, "rgba(156, 172, 204, 0.8)");
  g.addColorStop(0.45, "rgba(132, 150, 188, 0.3)");
  g.addColorStop(1, "rgba(120, 140, 180, 0)");
  sctx.fillStyle = g;
  sctx.fillRect(0, 0, SPR, SPR);

  // Cheap value-noise → curl. hash gives a stable pseudo-random per lattice point; smooth
  // interpolation between them, then a perpendicular finite-difference gradient yields a
  // divergence-free (swirly) flow field. A time offset makes the field slowly churn.
  // 32-bit integer hash → [0,1). Math.imul + unsigned shifts are essential: plain `*`
  // overflows into floats and `>>` sign-extends, which caps the range at 0.5 (a uniform,
  // barely-visible wash instead of real contrast).
  const hash = (x: number, y: number) => {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 4294967296;
  };
  const sm = (t: number) => t * t * (3 - 2 * t);
  function noise(x: number, y: number) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = sm(xf), v = sm(yf);
    const tl = hash(xi, yi), tr = hash(xi + 1, yi), bl = hash(xi, yi + 1), br = hash(xi + 1, yi + 1);
    const top = tl + (tr - tl) * u, bot = bl + (br - bl) * u;
    return top + (bot - top) * v;
  }
  const E = 0.001;
  function flow(x: number, y: number, t: number): [number, number] {
    const nx = x * FREQ + 13.2, ny = y * FREQ + 7.7 + t * FIELD_EVO;
    const dx = (noise(nx, ny + E) - noise(nx, ny - E)) / (2 * E);
    const dy = (noise(nx + E, ny) - noise(nx - E, ny)) / (2 * E);
    return [dy * FLOW, -dx * FLOW]; // perpendicular gradient = curl
  }
  // slow, drifting cloud-bank mask: 0 in clear sky, →1 in the thick of a bank
  function cloudMask(x: number, y: number, t: number) {
    const m = noise(x * MASK_FREQ + 41.3 + t * 0.012, y * MASK_FREQ + 17.7 - t * 0.007);
    return Math.max(0, Math.min(1, (m - MASK_FLOOR) / MASK_SPAN));
  }

  // particle state in parallel typed arrays (a few thousand → keep GC quiet)
  const COUNT = Math.min(1500, Math.round((W * H) / 2100));
  const px = new Float32Array(COUNT), py = new Float32Array(COUNT);
  const ivx = new Float32Array(COUNT), ivy = new Float32Array(COUNT); // decaying mouse impulse
  const life = new Float32Array(COUNT), maxlife = new Float32Array(COUNT);
  const size = new Float32Array(COUNT), alpha = new Float32Array(COUNT);
  const rnd = (a: number, b: number) => a + Math.random() * (b - a);
  function spawn(i: number, fresh: boolean) {
    px[i] = Math.random() * W;
    py[i] = Math.random() * H;
    ivx[i] = ivy[i] = 0;
    maxlife[i] = rnd(LIFE_MIN, LIFE_MAX);
    life[i] = fresh ? Math.random() * maxlife[i] : maxlife[i]; // stagger initial ages
    size[i] = rnd(SIZE_MIN, SIZE_MAX);
    alpha[i] = rnd(ALPHA_MIN, ALPHA_MAX);
  }
  for (let i = 0; i < COUNT; i++) spawn(i, true);

  // pointer: window-level (fires even though the canvas is pointer-events:none), with a
  // smoothed velocity so the smoke inherits the pointer's motion as a trailing wake.
  let mx = -9999, my = -9999, mvx = 0, mvy = 0, lastMx = 0, lastMy = 0, seen = false;
  function onMove(e: MouseEvent) {
    if (seen) { mvx = e.clientX - lastMx; mvy = e.clientY - lastMy; }
    mx = lastMx = e.clientX; my = lastMy = e.clientY; seen = true;
  }
  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("resize", resize);

  let last = performance.now();
  let level = 0; // 0..1 transition level: eases to 1 while active, back to 0 while not
  let notifiedFaded = false;
  let paused = false;
  const onVis = () => { paused = document.hidden; if (!paused) last = performance.now(); };
  document.addEventListener("visibilitychange", onVis);

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (paused) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const t = now / 1000;
    // ease `level` linearly toward the target (1 = forming, 0 = dissipating) over FADE seconds,
    // then shape it with a curve that's steep at the START of EACH direction — so forming and
    // dissipating both begin promptly. (A single shared curve makes the reverse direction hang
    // near full first, which reads as a delay before anything happens.)
    const target = (props.active ?? true) ? 1 : 0;
    const rate = dt / FADE;
    level = level < target ? Math.min(target, level + rate) : Math.max(target, level - rate);
    const e = target === 1 ? 1 - Math.pow(1 - level, 3) : Math.pow(level, 3);
    if (target === 0 && level <= 0 && !notifiedFaded) { notifiedFaded = true; emit("faded"); }
    else if (target > 0) notifiedFaded = false;
    const R2 = R * R;
    const impDecay = Math.exp(-IMP_DRAG * dt);
    mvx *= 0.8; mvy *= 0.8; // the pointer's own velocity relaxes toward rest between moves

    ctx.clearRect(0, 0, W, H); // transparent clear — the app shows straight through
    // normal alpha (NOT additive): overlapping puffs converge toward the puff tone instead of
    // summing past white, so dense banks read as thick cloud, never a glaring hotspot.
    ctx.globalCompositeOperation = "source-over";

    for (let i = 0; i < COUNT; i++) {
      const [fx, fy] = flow(px[i], py[i], t);
      // cursor interaction
      const dxm = px[i] - mx, dym = py[i] - my;
      const d2 = dxm * dxm + dym * dym;
      if (d2 < R2) {
        const d = Math.sqrt(d2) + 0.001;
        const f = 1 - d / R;
        const ux = dxm / d, uy = dym / d;
        ivx[i] += (ux * f * f * PUSH + -uy * f * SWIRL + mvx * f * WAKE) * dt;
        ivy[i] += (uy * f * f * PUSH + ux * f * SWIRL + mvy * f * WAKE) * dt;
      }
      ivx[i] *= impDecay; ivy[i] *= impDecay;
      px[i] += (fx + ivx[i]) * dt;
      py[i] += (fy + DRIFT_Y + ivy[i]) * dt;

      life[i] -= dt;
      if (life[i] <= 0 || px[i] < -SIZE_MAX || px[i] > W + SIZE_MAX || py[i] < -SIZE_MAX || py[i] > H + SIZE_MAX) {
        spawn(i, false);
        continue;
      }
      // fade in over the first 15% of life, out over the last 25%, full in between
      const fr = life[i] / maxlife[i];
      const fade = fr > 0.75 ? (1 - fr) / 0.25 : fr < 0.15 ? fr / 0.15 : 1;
      const mask = cloudMask(px[i], py[i], t);
      if (mask <= 0.001) continue; // clear sky — nothing to draw
      // puffs bloom small→full while forming and shrink back while dissipating (mirrors fade)
      const s = size[i] * (0.55 + 0.45 * e);
      ctx.globalAlpha = alpha[i] * fade * mask * e;
      ctx.drawImage(sprite, px[i] - s / 2, py[i] - s / 2, s, s);
    }
    ctx.globalAlpha = 1;
  }
  raf = requestAnimationFrame(frame);

  cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("resize", resize);
    document.removeEventListener("visibilitychange", onVis);
  };
});

let cleanup: (() => void) | null = null;
onBeforeUnmount(() => cleanup?.());
</script>

<template>
  <canvas ref="canvas" class="clouds" aria-hidden="true"></canvas>
</template>

<style scoped>
/* over everything, but purely decorative — clicks pass straight through to the app.
   the blur melts the individual puffs together into continuous smoke (kills the grain). */
.clouds { position: fixed; inset: 0; z-index: 9999; pointer-events: none; filter: blur(12px); }
</style>
