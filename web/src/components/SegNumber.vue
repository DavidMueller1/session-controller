<script setup lang="ts">
import SegDigit from "./SegDigit.vue";

// Renders a numeric string as 7-segment digits. Digits (and '-') become SegDigits; '.' becomes
// a lit decimal dot; anything else (e.g. the 'k' in "$12.3k", or '<') renders as a small amber
// glyph so odd formats still show something sensible.
defineProps<{ value: string }>();
// digits, '-', and ' ' (a blank/ghost digit used to pad to a fixed width) go through SegDigit
const isDigit = (c: string) => /[0-9 -]/.test(c);
</script>

<template>
  <span class="segnum">
    <template v-for="(ch, i) in value.split('')" :key="i">
      <span v-if="ch === '.'" class="seg-dot"></span>
      <SegDigit v-else-if="isDigit(ch)" :char="ch" />
      <span v-else class="seg-txt">{{ ch }}</span>
    </template>
  </span>
</template>

<style scoped>
.segnum { display: inline-flex; align-items: flex-end; gap: 1.5px; }
.seg-dot {
  width: 0.17em; height: 0.17em; border-radius: 50%; align-self: flex-end; margin: 0 1px 0.14em;
  background: var(--seg-on, #ffb020); filter: drop-shadow(0 0 1.1px var(--seg-glow, rgba(255, 176, 32, 0.85)));
}
.seg-txt { font: 700 0.66em/1 ui-monospace, "SF Mono", monospace; color: var(--seg-on, #ffb020); align-self: center; padding: 0 0.5px; }
</style>
