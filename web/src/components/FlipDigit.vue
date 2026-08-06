<script setup lang="ts">
import { ref, watch } from "vue";

// One split-flap digit (Solari / airport departure-board style). Two static halves show
// the settled state; two animated "leaves" flip on each change: the old top rotates down
// and away (revealing the new top behind it), then the new bottom drops in over the old
// bottom. Remounting the leaves via :key restarts the CSS animation on every change.
const props = defineProps<{ char: string }>();
const current = ref(props.char);
const previous = ref(props.char);
const flipId = ref(0);
watch(
  () => props.char,
  (nv, ov) => {
    previous.value = ov;
    current.value = nv;
    flipId.value++;
  },
);
</script>

<template>
  <span class="fd">
    <span class="card top"><span class="g">{{ current }}</span></span>
    <span class="card bottom"><span class="g">{{ previous }}</span></span>
    <span class="leaves" :key="flipId">
      <span class="card top leaf"><span class="g">{{ previous }}</span></span>
      <span class="card bottom leaf"><span class="g">{{ current }}</span></span>
    </span>
  </span>
</template>

<style scoped>
.fd {
  position: relative;
  display: inline-block;
  width: 0.66em;
  height: 1.16em;
  margin: 0 0.03em;
  perspective: 90px;
  font-family: "SF Mono", "Menlo", "Consolas", ui-monospace, monospace;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  border-radius: 2.5px;
  box-shadow: 0 0.5px 1.5px rgba(0, 0, 0, 0.5);
}
.card {
  position: absolute;
  left: 0;
  width: 100%;
  height: 50%;
  overflow: hidden;
  background: #171d26;
}
.card.top { top: 0; border-radius: 2.5px 2.5px 0 0; border-bottom: 0.5px solid rgba(0, 0, 0, 0.6); }
.card.bottom { bottom: 0; border-radius: 0 0 2.5px 2.5px; }
.g {
  position: absolute;
  left: 0;
  width: 100%;
  height: 200%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--flip-color, currentColor);
  line-height: 1;
}
.card.top .g { top: 0; }
.card.bottom .g { top: -100%; }
.leaves { position: absolute; inset: 0; }
.leaf { z-index: 2; }
.leaf.top {
  transform-origin: center bottom;
  backface-visibility: hidden;
  animation: fd-top var(--fd-half, 65ms) ease-in forwards;
}
.leaf.bottom {
  transform-origin: center top;
  backface-visibility: hidden;
  transform: rotateX(90deg);
  animation: fd-bot var(--fd-half, 65ms) ease-out var(--fd-half, 65ms) forwards;
}
@keyframes fd-top { to { transform: rotateX(-90deg); } }
@keyframes fd-bot { to { transform: rotateX(0deg); } }
@media (prefers-reduced-motion: reduce) {
  .leaf.top { display: none; }
  .leaf.bottom { animation: none; transform: rotateX(0deg); }
}
</style>
