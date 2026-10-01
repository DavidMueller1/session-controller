<script setup lang="ts">
import { computed } from "vue";
import SegNumber from "./SegNumber.vue";

// ECAM-style engine dial (like the N1 gauge): a 220° arc with caution/warning bands near the top,
// a needle at the value, and a 7-segment readout beside it. Green while normal, amber past 80%,
// red past 90% — or earlier, if the server already rates it as anything but "normal".
const props = defineProps<{ pct: number | null; severity?: string | null }>();

const CX = 18, CY = 17, R = 14;
const angle = (p: number) => ((200 - 2.2 * Math.max(0, Math.min(100, p))) * Math.PI) / 180;
const pt = (p: number, r = R) => [CX + r * Math.cos(angle(p)), CY - r * Math.sin(angle(p))];
const arc = (p0: number, p1: number, r = R) => {
  const [x0, y0] = pt(p0, r), [x1, y1] = pt(p1, r);
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${2.2 * (p1 - p0) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
};

const tone = computed(() => {
  const p = props.pct ?? 0;
  if (p >= 90) return "warn";
  if (p >= 80 || (props.severity && props.severity !== "normal")) return "caution";
  return "normal";
});
const needle = computed(() => pt(props.pct ?? 0, R - 3));
const readout = computed(() => (props.pct == null ? "   " : String(Math.round(props.pct)).padStart(3, " ")));
const ticks = [0, 25, 50, 75, 100].map((p) => [pt(p, R - 2.5), pt(p, R + 0.5)]);
</script>

<template>
  <span class="gauge" :class="tone">
    <svg class="dial" viewBox="0 0 36 24" aria-hidden="true">
      <path :d="arc(0, 100)" class="scale" />
      <path :d="arc(80, 90, R + 1.6)" class="band caution-band" />
      <path :d="arc(90, 100, R + 1.6)" class="band warn-band" />
      <line v-for="(t, i) in ticks" :key="i" :x1="t[0][0]" :y1="t[0][1]" :x2="t[1][0]" :y2="t[1][1]" class="tick" />
      <line v-if="pct != null" :x1="CX" :y1="CY" :x2="needle[0]" :y2="needle[1]" class="needle" />
      <circle :cx="CX" :cy="CY" r="1.8" class="hub" />
    </svg>
    <span class="window"><SegNumber :value="readout" /><span class="cur">%</span></span>
  </span>
</template>

<style scoped>
.gauge { display: inline-flex; align-items: center; gap: 4px; --seg-on: #3fb950; --seg-off: rgba(63, 185, 80, 0.09); --seg-glow: rgba(63, 185, 80, 0.75); --needle: #3fb950; }
.gauge.caution { --seg-on: #ffb020; --seg-off: rgba(255, 176, 32, 0.09); --seg-glow: rgba(255, 176, 32, 0.8); --needle: #ffb020; }
.gauge.warn { --seg-on: #f85149; --seg-off: rgba(248, 81, 73, 0.1); --seg-glow: rgba(248, 81, 73, 0.8); --needle: #f85149; }
.dial { width: 33px; height: 22px; display: block; overflow: visible; }
.scale { fill: none; stroke: #8b95a3; stroke-width: 1.3; stroke-linecap: round; }
.band { fill: none; stroke-width: 1.8; }
.caution-band { stroke: #ffb020; }
.warn-band { stroke: #f85149; }
.tick { stroke: #8b95a3; stroke-width: 1; }
.needle { stroke: var(--needle); stroke-width: 1.8; stroke-linecap: round; filter: drop-shadow(0 0 1.2px var(--seg-glow)); transition: all 0.4s ease; }
.hub { fill: var(--needle); }
/* same recessed window as the RMP readouts (App.vue's .rmp-window — scoped there, so mirrored) */
.window {
  display: inline-flex; align-items: center; gap: 3px; padding: 3px 7px; border-radius: 3px; background: #07090b;
  box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.85), 0 0 0 0.5px color-mix(in srgb, var(--seg-on) 18%, transparent);
}
.cur { font: 700 0.72em/1 ui-monospace, "SF Mono", monospace; color: var(--seg-on); filter: drop-shadow(0 0 1.1px var(--seg-glow)); }
</style>
