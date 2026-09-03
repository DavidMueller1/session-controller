<script setup lang="ts">
import { onMounted, ref } from "vue";
import { devUrl } from "../format";

interface Cfg {
  urlTemplate: string;
  command: string;
  install: string;
  env: string;
}
interface RepoRow extends Cfg {
  key: string;
  name: string;
}

const GLOBAL_KEY = "__global__";
defineProps<{ flight: boolean; notifySupported: boolean; notifyEnabled: boolean }>();
const emit = defineEmits<{ close: []; toggleFlight: []; toggleNotify: [] }>();

const repos = ref<RepoRow[]>([]);
const globals = ref<Cfg>({ urlTemplate: "", command: "", install: "", env: "" });
const loading = ref(true);
const savedKey = ref<string | null>(null);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

onMounted(async () => {
  try {
    const res = await fetch("/api/repos");
    const data = (await res.json()) as { global: Cfg; repos: RepoRow[] };
    globals.value = data.global;
    repos.value = data.repos;
  } catch {
    repos.value = [];
  } finally {
    loading.value = false;
  }
});

// preview the link a template produces, using :3000 as a stand-in port
const preview = (t: string) => devUrl(t, 3000);
// what a repo field falls back to when left blank: the global default, else the built-in
const ph = (field: keyof Cfg, fallback: string) => globals.value[field]?.trim() || fallback;

async function put(key: string, name: string | null, cfg: Cfg) {
  await fetch("/api/repos", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key,
      name,
      urlTemplate: cfg.urlTemplate.trim(),
      command: cfg.command.trim(),
      install: cfg.install.trim(),
      env: cfg.env.trim(),
    }),
  });
  savedKey.value = key;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (savedKey.value = null), 1500);
}
const save = (r: RepoRow) => put(r.key, r.name, r);
const saveGlobal = () => put(GLOBAL_KEY, null, globals.value);
</script>

<template>
  <div class="s-overlay" @click.self="emit('close')">
    <div class="s-panel">
      <div class="s-h">
        <span><i class="ti ti-settings"></i> Settings</span>
        <button class="icon" aria-label="close" @click="emit('close')"><i class="ti ti-x"></i></button>
      </div>

      <div class="s-prefs">
        <div class="s-pref">
          <span class="s-plabel">Board view</span>
          <div class="s-seg">
            <button :class="{ on: flight }" @click="flight || emit('toggleFlight')"><i class="ti ti-plane"></i> Board</button>
            <button :class="{ on: !flight }" @click="!flight || emit('toggleFlight')"><i class="ti ti-layout-list"></i> List</button>
          </div>
        </div>
        <div v-if="notifySupported" class="s-pref">
          <span class="s-plabel">Notify when a session needs you</span>
          <button class="s-toggle" :class="{ on: notifyEnabled }" @click="emit('toggleNotify')">
            <i class="ti" :class="notifyEnabled ? 'ti-bell' : 'ti-bell-off'"></i> {{ notifyEnabled ? "On" : "Off" }}
          </button>
        </div>
      </div>

      <div class="s-sep">dev servers</div>
      <p class="s-note">
        <b>Global defaults</b> apply to every repo; a per-repo value overrides just that field (blank inherits the
        global — shown as its placeholder). <b>Start</b>/<b>Install</b> run in the worktree via your login shell
        (nvm/PATH apply); install falls back to <code>pnpm install</code>. <b>Open URL</b> uses <code>{port}</code> for
        the detected port. <b>Env vars</b> (<code>KEY=value</code> per line) inject into start/install — a real
        <code>.env</code> in the worktree always wins.
      </p>

      <div v-if="loading" class="s-empty">loading…</div>
      <div v-else class="s-list">
        <!-- Global defaults -->
        <div class="s-row s-global">
          <div class="s-name"><i class="ti ti-world-cog"></i> Global defaults</div>
          <div class="s-fields">
            <label class="s-field">
              <span class="s-label">start command</span>
              <input v-model="globals.command" class="s-input" placeholder="pnpm dev" spellcheck="false" @keydown.enter="saveGlobal" @blur="saveGlobal" />
            </label>
            <label class="s-field">
              <span class="s-label">install command</span>
              <input v-model="globals.install" class="s-input" placeholder="pnpm install" spellcheck="false" @keydown.enter="saveGlobal" @blur="saveGlobal" />
            </label>
            <label class="s-field">
              <span class="s-label">open URL</span>
              <input v-model="globals.urlTemplate" class="s-input" placeholder="http://localhost:{port}" spellcheck="false" @keydown.enter="saveGlobal" @blur="saveGlobal" />
              <span class="s-preview">→ {{ preview(globals.urlTemplate) }}</span>
            </label>
            <label class="s-field">
              <span class="s-label">env vars</span>
              <textarea v-model="globals.env" class="s-input s-env" rows="2" placeholder="KEY=value" spellcheck="false" @blur="saveGlobal"></textarea>
            </label>
          </div>
          <span class="s-saved" :class="{ show: savedKey === GLOBAL_KEY }"><i class="ti ti-check"></i> saved</span>
        </div>

        <div class="s-sep">per repo</div>
        <div v-if="!repos.length" class="s-empty">no repos with strips yet</div>

        <div v-for="r in repos" :key="r.key" class="s-row">
          <div class="s-name" :title="r.key">{{ r.name }}</div>
          <div class="s-fields">
            <label class="s-field">
              <span class="s-label">start command</span>
              <input v-model="r.command" class="s-input" :placeholder="ph('command', 'pnpm dev')" spellcheck="false" @keydown.enter="save(r)" @blur="save(r)" />
            </label>
            <label class="s-field">
              <span class="s-label">install command</span>
              <input v-model="r.install" class="s-input" :placeholder="ph('install', 'pnpm install')" spellcheck="false" @keydown.enter="save(r)" @blur="save(r)" />
            </label>
            <label class="s-field">
              <span class="s-label">open URL</span>
              <input v-model="r.urlTemplate" class="s-input" :placeholder="ph('urlTemplate', 'http://localhost:{port}')" spellcheck="false" @keydown.enter="save(r)" @blur="save(r)" />
              <span class="s-preview">→ {{ preview(r.urlTemplate.trim() || globals.urlTemplate) }}</span>
            </label>
            <label class="s-field">
              <span class="s-label">env vars</span>
              <textarea v-model="r.env" class="s-input s-env" rows="2" :placeholder="ph('env', 'KEY=value')" spellcheck="false" @blur="save(r)"></textarea>
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
.s-global { background: rgba(88, 166, 255, 0.05); border: 0.5px solid var(--border-soft); }
.s-name { font-size: 12px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-top: 4px; display: inline-flex; align-items: center; gap: 5px; }
.s-name i { color: var(--text-faint); }
.s-sep { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); padding: 12px 8px 4px; }

/* Preferences (board view + notifications), moved out of the header */
.s-prefs { flex: none; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-bottom: 0.5px solid var(--border-soft); }
.s-pref { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.s-plabel { font-size: 12.5px; color: var(--text); }
.s-seg { display: inline-flex; border: 0.5px solid var(--border); border-radius: 8px; overflow: hidden; }
.s-seg button { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 11px; color: var(--text-faint); }
.s-seg button:hover { color: var(--text-dim); }
.s-seg button.on { background: var(--chip); color: var(--text-hi); }
.s-toggle { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; font-size: 12px; padding: 5px 11px; border: 0.5px solid var(--border); border-radius: 8px; color: var(--text-faint); }
.s-toggle:hover { color: var(--text-dim); }
.s-toggle.on { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 40%, transparent); }
.s-fields { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.s-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.s-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint); }
.s-input { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 12px; width: 100%; }
.s-env { resize: vertical; min-height: 40px; line-height: 1.4; }
.s-preview { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 10px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.s-saved { font-size: 11px; color: var(--green); opacity: 0; transition: opacity 0.15s; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; padding-top: 4px; }
.s-saved.show { opacity: 1; }
@media (max-width: 640px) { .s-row { grid-template-columns: 1fr; gap: 6px; } }
</style>
