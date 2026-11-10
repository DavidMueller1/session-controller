<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { projectName } from "../format";
import { type LayoutPane, type SavedLayout, fetchLayout, paneKey, restoreLayout, restoredByDefault, savedWhen } from "../itermLayout";

const emit = defineEmits<{ close: [] }>();

const layout = ref<SavedLayout | null>(null);
const loading = ref(true);
const picked = ref(new Set<string>());
const state = ref<"idle" | "restoring" | "failed">("idle");

onMounted(async () => {
  layout.value = await fetchLayout();
  loading.value = false;
  const l = layout.value;
  if (!l) return;
  l.windows.forEach((w, wi) => w.tabs.forEach((panes, ti) => panes.forEach((p, pi) => restoredByDefault(l, p) && picked.value.add(paneKey(wi, ti, pi)))));
});

function toggle(key: string) {
  const next = new Set(picked.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  picked.value = next;
}

const tabCount = computed(() => {
  const l = layout.value;
  if (!l) return 0;
  return l.windows.reduce((n, w, wi) => n + w.tabs.filter((panes, ti) => panes.some((_, pi) => picked.value.has(paneKey(wi, ti, pi)))).length, 0);
});

const paneLabel = (p: LayoutPane) => (p.kind === "claude" ? p.title || p.sessionId.slice(0, 8) : "Shell");

async function restore() {
  const l = layout.value;
  if (!l || !tabCount.value) return;
  state.value = "restoring";
  const skip: string[] = [];
  l.windows.forEach((w, wi) => w.tabs.forEach((panes, ti) => panes.forEach((_, pi) => picked.value.has(paneKey(wi, ti, pi)) || skip.push(paneKey(wi, ti, pi)))));
  if (await restoreLayout(l.at, skip)) emit("close");
  else state.value = "failed";
}
</script>

<template>
  <div class="lr-overlay" @click.self="emit('close')">
    <div class="lr-panel">
      <div class="lr-h">
        <span><i class="ti ti-app-window"></i> Restore iTerm layout<span v-if="layout" class="lr-when">saved {{ savedWhen(layout.at) }}</span></span>
        <button class="icon" aria-label="close" @click="emit('close')"><i class="ti ti-x"></i></button>
      </div>

      <div v-if="loading" class="lr-empty">loading…</div>
      <div v-else-if="!layout" class="lr-empty">No iTerm layout saved yet. It's saved while iTerm is open.</div>
      <div v-else class="lr-body">
        <section v-for="(w, wi) in layout.windows" :key="wi" class="lr-win">
          <div class="lr-win-h">Window {{ wi + 1 }} <span class="lr-dim">{{ w.bounds[2] - w.bounds[0] }}×{{ w.bounds[3] - w.bounds[1] }}</span></div>
          <div v-for="(panes, ti) in w.tabs" :key="ti" class="lr-tab">
            <span class="lr-tab-n">{{ ti + 1 }}</span>
            <div class="lr-panes">
              <label
                v-for="(p, pi) in panes"
                :key="pi"
                class="lr-pane"
                :class="{ off: !picked.has(paneKey(wi, ti, pi)), shell: p.kind === 'shell' }"
                :title="p.cwd"
              >
                <input type="checkbox" :checked="picked.has(paneKey(wi, ti, pi))" :disabled="p.live" @change="toggle(paneKey(wi, ti, pi))" />
                <i class="ti" :class="p.kind === 'claude' ? 'ti-plane' : 'ti-terminal-2'"></i>
                <span class="lr-name">{{ paneLabel(p) }}</span>
                <span class="lr-dir">{{ projectName(p.cwd) }}</span>
                <span v-if="p.live" class="lr-badge">running</span>
                <span v-else-if="p.kind === 'claude' && p.landed" class="lr-badge">landed</span>
              </label>
            </div>
          </div>
        </section>
      </div>

      <div v-if="layout" class="lr-foot">
        <span v-if="state === 'failed'" class="lr-err"><i class="ti ti-alert-triangle"></i> iTerm didn't respond. Is Automation allowed for Session Controller?</span>
        <button class="lr-btn" @click="emit('close')">Cancel</button>
        <button class="lr-btn primary" :disabled="!tabCount || state === 'restoring'" @click="restore">
          <i class="ti" :class="state === 'restoring' ? 'ti-loader-2 spin' : 'ti-player-play'"></i>
          Restore {{ tabCount }} tab{{ tabCount === 1 ? "" : "s" }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.lr-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.lr-panel { width: min(860px, 94vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.lr-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 500; color: var(--text); }
.lr-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.lr-h .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.lr-when { margin-left: 8px; font-size: 11.5px; font-weight: 400; color: var(--text-faint); }
.lr-empty { padding: 20px 14px; font-size: 12px; color: var(--text-faint); }
.lr-body { flex: 1; min-height: 0; overflow: auto; display: flex; gap: 12px; padding: 12px 14px; align-items: flex-start; }
.lr-win { flex: 1 1 260px; min-width: 240px; border: 0.5px solid var(--border-soft); border-radius: 10px; padding: 8px; background: rgba(255, 255, 255, 0.015); }
.lr-win-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); padding: 2px 4px 8px; }
.lr-dim { margin-left: 4px; letter-spacing: 0; text-transform: none; font-family: ui-monospace, "SF Mono", Menlo, monospace; }
.lr-tab { display: flex; gap: 6px; align-items: flex-start; padding: 2px 0; }
.lr-tab-n { flex: none; width: 16px; padding-top: 6px; text-align: right; font: 600 10px/1 ui-monospace, "SF Mono", Menlo, monospace; color: var(--text-faint); }
.lr-panes { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.lr-pane { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 6px; border-radius: 6px; font-size: 12px; color: var(--text-hi); cursor: pointer; }
.lr-pane:hover { background: rgba(255, 255, 255, 0.04); }
.lr-pane.shell { color: var(--text-dim); }
.lr-pane.off { opacity: 0.45; }
.lr-pane input { margin: 0; accent-color: var(--blue); }
.lr-pane i { flex: none; color: var(--text-faint); font-size: 13px; }
.lr-name { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
.lr-dir { flex: 1 1 0; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font: 11px/1.2 ui-monospace, "SF Mono", Menlo, monospace; color: var(--text-faint); }
.lr-badge { flex: none; font-size: 10px; border: 0.5px solid var(--border); border-radius: 5px; padding: 0 5px; color: var(--text-faint); }
.lr-foot { flex: none; display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px 14px; border-top: 0.5px solid var(--border-soft); }
.lr-err { margin-right: auto; font-size: 11.5px; color: var(--red); display: inline-flex; align-items: center; gap: 5px; }
.lr-btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 12px; border: 0.5px solid var(--border); border-radius: 8px; color: var(--text-dim); }
.lr-btn:hover { color: var(--text-hi); border-color: var(--gray); }
.lr-btn.primary { color: var(--blue); border-color: color-mix(in srgb, var(--blue) 50%, transparent); font-weight: 600; }
.lr-btn.primary:hover { background: color-mix(in srgb, var(--blue) 15%, transparent); }
.lr-btn:disabled { opacity: 0.5; cursor: default; }
.lr-btn .spin { animation: lr-spin 0.8s linear infinite; }
@keyframes lr-spin { to { transform: rotate(360deg); } }
@media (max-width: 640px) { .lr-body { flex-direction: column; align-items: stretch; } }
</style>
