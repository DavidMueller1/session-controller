<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const props = defineProps<{ aircraftId: string; title: string; port: number | null; kind?: "server" | "install" }>();
const emit = defineEmits<{ close: [] }>();

const qs = props.kind === "install" ? "?kind=install" : "";

const lines = ref<string[]>([]);
const body = ref<HTMLElement | null>(null);
const atBottom = ref(true);
let es: EventSource | null = null;

const MAX = 2000; // cap retained lines so a chatty server can't grow the DOM unbounded

function push(chunk: string) {
  const incoming = chunk.split("\n").filter((l) => l.length);
  if (!incoming.length) return;
  lines.value.push(...incoming);
  if (lines.value.length > MAX) lines.value.splice(0, lines.value.length - MAX);
  if (atBottom.value) nextTick(scrollToBottom);
}

function scrollToBottom() {
  const el = body.value;
  if (el) el.scrollTop = el.scrollHeight;
}
function onScroll() {
  const el = body.value;
  if (el) atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

onMounted(async () => {
  try {
    const res = await fetch(`/api/aircraft/${props.aircraftId}/dev/logs${qs}`);
    const { log } = (await res.json()) as { log: string };
    if (log) lines.value = log.split("\n").filter((l) => l.length).slice(-MAX);
  } catch {
    /* no backlog */
  }
  await nextTick(scrollToBottom);
  es = new EventSource(`/api/aircraft/${props.aircraftId}/dev/logs/stream${qs}`);
  es.onmessage = (e) => push(e.data);
});

onBeforeUnmount(() => es?.close());
</script>

<template>
  <Teleport to="body">
    <div class="dl-overlay" @click.self="emit('close')">
      <div class="dl-panel">
        <div class="dl-h">
          <span class="dl-title">
            <i class="ti ti-terminal-2"></i> {{ title }}
            <span v-if="port" class="dl-port">:{{ port }}</span>
          </span>
          <button class="icon" aria-label="close" @click="emit('close')"><i class="ti ti-x"></i></button>
        </div>
        <div ref="body" class="dl-body mono" @scroll="onScroll">
          <div v-for="(l, i) in lines" :key="i" class="dl-line">{{ l }}</div>
          <div v-if="!lines.length" class="dl-empty">waiting for output…</div>
        </div>
        <button v-if="!atBottom" class="dl-follow" @click="atBottom = true; scrollToBottom()">
          <i class="ti ti-arrow-down"></i> follow
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.dl-overlay { position: fixed; inset: 0; z-index: 70; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.dl-panel { position: relative; width: min(1000px, 92vw); height: min(680px, 84vh); display: flex; flex-direction: column; background: #05070a; border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.6); overflow: hidden; }
.dl-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; color: var(--text); background: var(--panel); }
.dl-title { display: inline-flex; align-items: center; gap: 7px; font-weight: 500; }
.dl-port { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 11px; color: var(--green); }
.dl-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.dl-h .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.dl-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 14px; font-size: 12px; line-height: 1.45; color: #c8d1dc; }
.dl-line { white-space: pre-wrap; word-break: break-word; }
.dl-empty { color: var(--text-faint); }
.dl-follow { position: absolute; bottom: 14px; right: 18px; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--bg); background: var(--green); border: 0; border-radius: 14px; padding: 4px 10px; cursor: pointer; box-shadow: 0 3px 10px rgba(0, 0, 0, 0.4); }
</style>
