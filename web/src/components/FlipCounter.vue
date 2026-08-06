<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import FlipDigit from "./FlipDigit.vue";

// A two-digit split-flap counter. When the value changes it steps toward the target ONE
// integer at a time (4 → 5 → 6), so each digit flips exactly one number per tick — the
// old-school departure-board roll. Colour is passed through to the digits.
const props = defineProps<{ value: number; color?: string }>();

const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const STEP_MS = 280; // one step per flip; must exceed the flip total (2 × --fd-half = 260ms)
const clamp = (n: number) => Math.max(0, Math.min(99, Math.round(n))); // two-digit for now

const shown = ref(clamp(props.value));
let timer: ReturnType<typeof setInterval> | undefined;

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
function run() {
  if (timer) return;
  timer = setInterval(() => {
    const target = clamp(props.value);
    if (shown.value === target) return stop();
    shown.value += shown.value < target ? 1 : -1;
  }, STEP_MS);
}

watch(
  () => props.value,
  () => {
    const target = clamp(props.value);
    if (reduce) return void (shown.value = target); // respect reduced-motion: jump, no roll
    if (shown.value !== target) run();
  },
);
onBeforeUnmount(stop);

const digits = computed(() => String(shown.value).padStart(2, "0").split(""));
</script>

<template>
  <span class="flip-counter" :style="{ '--flip-color': color || 'currentColor' }">
    <FlipDigit v-for="(c, i) in digits" :key="i" :char="c" />
  </span>
</template>

<style scoped>
.flip-counter { display: inline-flex; gap: 1px; font-size: 13px; }
</style>
