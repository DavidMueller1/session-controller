<script setup lang="ts">
import { onMounted, ref } from "vue";

const props = defineProps<{ sinceBuild?: number | null }>();
defineEmits<{ close: [] }>();

interface Entry {
  build: number | null;
  date: string;
  items: string[];
}
const entries = ref<Entry[]>([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const res = await fetch("/api/changelog");
    const data = (await res.json()) as { entries: Entry[] };
    entries.value = data.entries ?? [];
  } catch {
    entries.value = [];
  } finally {
    loading.value = false;
  }
});

// tiny, safe markdown: escape, then **bold** → <b>. The source is our own CHANGELOG.md.
function fmt(s: string): string {
  const esc = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}
const isNew = (b: number | null) => props.sinceBuild != null && b != null && b > props.sinceBuild;
</script>

<template>
  <Teleport to="body">
    <div class="w-overlay" @click.self="$emit('close')">
      <div class="w-panel">
        <div class="w-head">
          <span class="w-title"><i class="ti ti-sparkles"></i> What's new</span>
          <button class="icon" aria-label="close" @click="$emit('close')"><i class="ti ti-x"></i></button>
        </div>
        <div class="w-body">
          <div v-if="loading" class="w-empty">loading…</div>
          <div v-else-if="!entries.length" class="w-empty">No changelog yet.</div>
          <div v-for="e in entries" v-else :key="(e.build ?? 0) + e.date" class="w-entry" :class="{ fresh: isNew(e.build) }">
            <div class="w-meta">
              <span class="w-build">v{{ e.build }}</span>
              <span class="w-date">{{ e.date }}</span>
              <span v-if="isNew(e.build)" class="w-new">new</span>
            </div>
            <ul class="w-items">
              <li v-for="(it, i) in e.items" :key="i" v-html="fmt(it)"></li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.w-overlay { position: fixed; inset: 0; z-index: 63; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.w-panel { width: min(560px, 94vw); max-height: 84vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.w-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 15px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 600; color: var(--text-hi); }
.w-title { display: inline-flex; align-items: center; gap: 7px; }
.w-title i { color: var(--amber); }
.w-head .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.w-head .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.w-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 16px 18px; }
.w-empty { color: var(--text-faint); font-size: 12.5px; padding: 24px 2px; text-align: center; }

.w-entry { padding: 12px 0; border-bottom: 0.5px solid var(--border-soft); }
.w-entry:last-child { border-bottom: none; }
.w-meta { display: flex; align-items: baseline; gap: 8px; margin-bottom: 7px; }
.w-build { font-size: 12px; font-weight: 700; color: var(--text-hi); font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.w-date { font-size: 11px; color: var(--text-faint); }
.w-new { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--bg); background: var(--amber); border-radius: 5px; padding: 1px 6px; }
.w-items { list-style: none; display: flex; flex-direction: column; gap: 6px; padding-left: 2px; }
.w-items li { position: relative; padding-left: 15px; font-size: 12.5px; line-height: 1.5; color: var(--text-dim); }
.w-items li::before { content: ""; position: absolute; left: 2px; top: 7px; width: 4px; height: 4px; border-radius: 50%; background: var(--text-faint); }
.w-items li :deep(b) { color: var(--text-hi); font-weight: 600; }
.w-entry.fresh .w-items li::before { background: var(--amber); }
</style>
