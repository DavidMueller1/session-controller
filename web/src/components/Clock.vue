<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from "vue";

// The header clock ticks every second — isolated in its own component so that 1s update
// re-renders ONLY this span, not the whole App (which would cascade into every strip).
const time = ref(new Date().toLocaleTimeString());
let id: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  id = setInterval(() => (time.value = new Date().toLocaleTimeString()), 1000);
});
onBeforeUnmount(() => clearInterval(id));
</script>

<template>
  <span>{{ time }}</span>
</template>
