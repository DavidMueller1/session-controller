<script setup lang="ts">
// One 7-segment digit (Airbus RMP / LED style), drawn as SVG so we get authentic lit + faint
// "ghost" (unlit) segments and an amber glow with no webfont. Colour/glow come from CSS vars
// set by the panel, so the same digit serves the bright ACTIVE and dim STANDBY fields.
const props = defineProps<{ char: string }>();
//            a
//          f   b
//            g
//          e   c
//            d
const SEG: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abdeg", "3": "abcdg", "4": "bcfg",
  "5": "acdfg", "6": "acdefg", "7": "abc", "8": "abcdefg", "9": "abcdfg",
  "-": "g", " ": "",
};
const on = (s: string) => (SEG[props.char] ?? "").includes(s);
</script>

<template>
  <svg class="seg" viewBox="0 0 24 44" aria-hidden="true">
    <rect class="s" :class="{ on: on('a') }" x="6" y="2" width="12" height="4" rx="1.6" />
    <rect class="s" :class="{ on: on('f') }" x="2" y="6" width="4" height="14" rx="1.6" />
    <rect class="s" :class="{ on: on('b') }" x="18" y="6" width="4" height="14" rx="1.6" />
    <rect class="s" :class="{ on: on('g') }" x="6" y="20" width="12" height="4" rx="1.6" />
    <rect class="s" :class="{ on: on('e') }" x="2" y="24" width="4" height="14" rx="1.6" />
    <rect class="s" :class="{ on: on('c') }" x="18" y="24" width="4" height="14" rx="1.6" />
    <rect class="s" :class="{ on: on('d') }" x="6" y="38" width="12" height="4" rx="1.6" />
  </svg>
</template>

<style scoped>
.seg { width: 0.6em; height: 1.08em; display: block; }
.s { fill: var(--seg-off, rgba(255, 176, 32, 0.09)); transition: fill 0.16s ease; }
.s.on { fill: var(--seg-on, #ffb020); filter: drop-shadow(0 0 1.1px var(--seg-glow, rgba(255, 176, 32, 0.85))); }
@media (prefers-reduced-motion: reduce) { .s { transition: none; } }
</style>
