<script setup lang="ts">
import { onMounted, ref } from "vue";
import { devUrl } from "../format";

interface RepoRow {
  key: string;
  name: string;
  urlTemplate: string;
  command: string;
}

const emit = defineEmits<{ close: [] }>();

const repos = ref<RepoRow[]>([]);
const loading = ref(true);
const savedKey = ref<string | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  try {
    const res = await fetch("/api/repos");
    repos.value = (await res.json()) as RepoRow[];
  } catch {
    repos.value = [];
  } finally {
    loading.value = false;
  }
});

// preview the link a template produces, using :3000 as a stand-in port
const preview = (t: string) => devUrl(t, 3000);

async function save(row: RepoRow) {
  await fetch("/api/repos", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: row.key, name: row.name, urlTemplate: row.urlTemplate.trim(), command: row.command.trim() }),
  });
  savedKey.value = row.key;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (savedKey.value = null), 1500);
}
</script>

<template>
  <div class="s-overlay" @click.self="emit('close')">
    <div class="s-panel">
      <div class="s-h">
        <span><i class="ti ti-settings"></i> Settings — Dev servers</span>
        <button class="icon" aria-label="close" @click="emit('close')"><i class="ti ti-x"></i></button>
      </div>

      <p class="s-note">
        Per repo (applies to every worktree). <b>Command</b> is what the Start button runs in the worktree — e.g.
        <code>pnpm dev</code> (runs in your login shell, so nvm/PATH apply). <b>Open URL</b> is used by the port badge;
        use <code>{port}</code> for the detected port, empty = <code>http://localhost:{port}</code>.
      </p>

      <div v-if="loading" class="s-empty">loading repos…</div>
      <div v-else-if="!repos.length" class="s-empty">no repos with strips yet</div>

      <div v-else class="s-list">
        <div v-for="r in repos" :key="r.key" class="s-row">
          <div class="s-name" :title="r.key">{{ r.name }}</div>
          <div class="s-fields">
            <label class="s-field">
              <span class="s-label">start command</span>
              <input
                v-model="r.command"
                class="s-input"
                placeholder="pnpm dev"
                spellcheck="false"
                @keydown.enter="save(r)"
                @blur="save(r)"
              />
            </label>
            <label class="s-field">
              <span class="s-label">open URL</span>
              <input
                v-model="r.urlTemplate"
                class="s-input"
                placeholder="http://localhost:{port}"
                spellcheck="false"
                @keydown.enter="save(r)"
                @blur="save(r)"
              />
              <span class="s-preview">→ {{ preview(r.urlTemplate) }}</span>
            </label>
          </div>
          <span class="s-saved" :class="{ show: savedKey === r.key }"><i class="ti ti-check"></i> saved</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.s-overlay { position: fixed; inset: 0; z-index: 60; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.s-panel { width: min(720px, 94vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.s-h { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 500; color: var(--text); }
.s-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.s-h .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.s-note { flex: none; margin: 0; padding: 10px 14px; font-size: 12px; line-height: 1.5; color: var(--text-dim); border-bottom: 0.5px solid var(--border-soft); }
.s-note code { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 11px; background: var(--chip); border-radius: 4px; padding: 1px 4px; color: var(--text); }
.s-empty { padding: 20px 14px; font-size: 12px; color: var(--text-faint); }
.s-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px; }
.s-row { display: grid; grid-template-columns: 160px 1fr auto; align-items: start; gap: 12px; padding: 10px 8px; border-radius: 8px; }
.s-row:hover { background: rgba(255, 255, 255, 0.02); }
.s-name { font-size: 12px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-top: 4px; }
.s-fields { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.s-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.s-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); }
.s-input { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 12px; width: 100%; }
.s-preview { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 10px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-saved { font-size: 11px; color: var(--green); opacity: 0; transition: opacity 0.15s; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; padding-top: 4px; }
.s-saved.show { opacity: 1; }
@media (max-width: 640px) { .s-row { grid-template-columns: 1fr; gap: 6px; } }
</style>
