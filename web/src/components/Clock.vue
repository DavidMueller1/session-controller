<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import FlipDigit from "./FlipDigit.vue";

// The header clock ticks every second — isolated in its own component so that 1s update
// re-renders ONLY this span, not the whole App (which would cascade into every strip).
// Shown as a split-flap board in 24-hour time, the way ATC keeps it; each card flips on its own.
const now = ref(new Date());
let id: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  id = setInterval(() => (now.value = new Date()), 1000);
});
onBeforeUnmount(() => clearInterval(id));

const two = (n: number) => String(n).padStart(2, "0");
const groups = computed(() => [now.value.getHours(), now.value.getMinutes(), now.value.getSeconds()].map(two));
</script>

<template>
  <span class="flip-clock" :title="now.toLocaleTimeString()">
    <template v-for="(g, gi) in groups" :key="gi">
      <span v-if="gi" class="sep">:</span>
      <FlipDigit v-for="(c, ci) in g" :key="ci" :char="c" />
    </template>
  </span>
</template>

<style scoped>
.flip-clock { display: inline-flex; align-items: center; gap: 1px; font-size: 13px; --flip-color: var(--text-dim); }
.sep { font-weight: 700; color: var(--text-faint); padding: 0 1px; transform: translateY(-0.04em); }
</style>
