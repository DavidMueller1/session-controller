<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from "vue";
import { heli } from "../eggState";

// Easter egg: a little top-down helicopter that chases the cursor with helicopter-like motion —
// it lags and overshoots (inertia), noses into the direction it's travelling, and bobs while it
// hovers, rotor spinning the whole time. It also blasts the clouds aside with its downwash (via
// the shared `heli` state the Clouds layer reads). Full-viewport, pointer-events:none, and fully
// tears down on unmount. Honours reduced-motion (renders nothing).

const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const root = ref<HTMLDivElement | null>(null);

// --- feel knobs --------------------------------------------------------------------------
const SIZE = 116; // on-screen helicopter size (px)
const STIFF = 0.009; // pull toward the cursor (spring) — higher = chases harder
const DAMP = 0.91; // per-frame velocity retention — lower = settles faster, higher = more drift
const MAX_SPEED = 6.5; // cap on flight speed (px/frame) so a fast cursor jump doesn't make it dart
const TURN = 0.12; // how fast the nose swings toward the travel heading
const TURN_MIN_SPEED = 0.5; // below this speed it holds heading (no spinning in place)
const BOB_AMP = 6; // idle hover bob height (px)
const BOB_FREQ = 0.005; // idle bob speed
const ROTOR_SHIFT = -0.1; // rotor hub sits ~10% above the sprite centre → shift the disk up
// -----------------------------------------------------------------------------------------

let raf = 0;
let cleanup: (() => void) | null = null;

onMounted(() => {
  if (reduce) return;
  const el = root.value!;
  el.style.setProperty("--shift", `${ROTOR_SHIFT * 100}%`);

  let x = window.innerWidth * 0.5;
  let y = window.innerHeight * 0.4;
  let vx = 0, vy = 0;
  let heading = 0; // radians; 0 = nose up (the sprite's rest orientation)
  let mx = x, my = y;
  const onMove = (e: MouseEvent) => { mx = e.clientX; my = e.clientY; };
  window.addEventListener("mousemove", onMove, { passive: true });

  heli.active = true;
  let last = performance.now();
  let paused = false;
  const onVis = () => { paused = document.hidden; if (!paused) last = performance.now(); };
  document.addEventListener("visibilitychange", onVis);

  function frame(now: number) {
    raf = requestAnimationFrame(frame);
    if (paused) return;
    const dt = Math.min(2.5, (now - last) / 16.67); // ~frames elapsed (clamped)
    last = now;

    // spring chase with inertia: accelerate toward the cursor, then damp → lag + overshoot
    vx += (mx - x) * STIFF * dt;
    vy += (my - y) * STIFF * dt;
    const d = Math.pow(DAMP, dt);
    vx *= d; vy *= d;
    // clamp top speed so a big cursor jump glides rather than teleporting the heli
    const sp = Math.hypot(vx, vy);
    if (sp > MAX_SPEED) { vx = (vx / sp) * MAX_SPEED; vy = (vy / sp) * MAX_SPEED; }
    x += vx * dt; y += vy * dt;

    const speed = Math.hypot(vx, vy);
    // nose turns toward the travel direction (shortest-arc), but only while actually moving
    if (speed > TURN_MIN_SPEED) {
      const tgt = Math.atan2(vy, vx) + Math.PI / 2; // sprite nose = up = velocity dir
      let delta = tgt - heading;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      heading += delta * Math.min(1, TURN * dt);
    }
    // idle hover bob — strongest when nearly stationary, gone at speed
    const idle = Math.max(0, 1 - speed / 4);
    const bob = Math.sin(now * BOB_FREQ) * BOB_AMP * idle;

    el.style.transform = `translate(${x - SIZE / 2}px, ${y - SIZE / 2 + bob}px) rotate(${heading}rad)`;
    heli.x = x; heli.y = y; // expose the downwash centre for the clouds
  }
  raf = requestAnimationFrame(frame);

  cleanup = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener("mousemove", onMove);
    document.removeEventListener("visibilitychange", onVis);
    heli.active = false;
  };
});
onBeforeUnmount(() => cleanup?.());
</script>

<template>
  <div ref="root" class="heli" aria-hidden="true" :style="{ width: SIZE + 'px', height: SIZE + 'px' }">
    <img class="heli-body" src="/heli-body.png" alt="" draggable="false" />
    <img class="heli-rotor" src="/heli-rotor.png" alt="" draggable="false" />
  </div>
</template>

<style scoped>
/* above the clouds (z 9999) — it flies over them; purely decorative so clicks pass through */
.heli { position: fixed; top: 0; left: 0; z-index: 10000; pointer-events: none; will-change: transform; }
.heli-body { position: absolute; inset: 0; width: 100%; height: 100%; display: block; filter: drop-shadow(0 6px 10px rgba(0, 0, 0, 0.4)); }
/* the rotor disk spins continuously; nudged up so it sits on the body's rotor hub */
.heli-rotor { position: absolute; left: 0; width: 100%; height: 100%; top: var(--shift, -10%); display: block; transform-origin: 50% 50%; animation: heli-spin 0.14s linear infinite; }
@keyframes heli-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .heli-rotor { animation: none; } }
</style>
