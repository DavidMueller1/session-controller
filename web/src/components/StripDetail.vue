<script setup lang="ts">
import { computed } from "vue";
import type { Aircraft } from "../types";
import { STATE, formatAge, laneOf } from "../format";

const props = defineProps<{ aircraft: Aircraft; now: number }>();
const emit = defineEmits<{ close: []; open: [id: string] }>();

const a = computed(() => props.aircraft);
const meta = computed(() => STATE[a.value.state]);

const SOURCE_LABEL: Record<string, string> = {
  hook: "live via hooks",
  registry: "live via Claude Code registry",
  inferred: "inferred from transcript (≈8s delay)",
};
const SURFACE_LABEL: Record<string, string> = { cli: "terminal", desktop: "desktop" };
const SURFACE_ICON: Record<string, string> = { cli: "ti-terminal-2", desktop: "ti-device-desktop" };

const surfaces = computed(() => a.value.surfaces ?? [a.value.source]);
const stateSince = computed(() => a.value.stateSince ?? a.value.lastActivityAt);
const inState = computed(() => formatAge(stateSince.value ? props.now - stateSince.value : null));
const abs = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : "—");

const ctx = computed(() => {
  if (a.value.contextPct == null) return "—";
  return `${Math.round(a.value.contextPct * 100)}% · ${(a.value.contextTokens ?? 0).toLocaleString()} tokens`;
});

const dev = computed(() => a.value.devServer ?? null);
const devSummary = computed(() => {
  const parts: string[] = [];
  if (a.value.devManaged) parts.push("running (managed)");
  else if (a.value.devExit) parts.push(`exited${a.value.devExit.code != null ? ` (code ${a.value.devExit.code})` : ""}`);
  if (a.value.devInstall?.running) parts.push("installing…");
  return parts.join(" · ");
});
</script>

<template>
  <Teleport to="body">
    <div class="d-overlay" @click.self="emit('close')">
      <div class="d-panel">
        <div class="d-h">
          <span class="d-title">{{ a.title || a.id }}</span>
          <span class="d-badge" :style="{ background: meta.color, color: 'var(--bg)' }">{{ meta.label }}</span>
          <button class="icon" aria-label="close" @click="emit('close')"><i class="ti ti-x"></i></button>
        </div>

        <div class="d-body">
          <div class="d-row"><span class="d-k">State</span><span class="d-v">{{ meta.label }} · {{ laneOf(a) }} lane · {{ inState }} in state</span></div>
          <div class="d-row"><span class="d-k">Project</span><span class="d-v mono">{{ a.project || "—" }}</span></div>
          <div class="d-row"><span class="d-k">Branch</span><span class="d-v mono">{{ a.branch || "—" }}</span></div>
          <div class="d-row"><span class="d-k">Model</span><span class="d-v mono">{{ a.model || "—" }}</span></div>
          <div class="d-row">
            <span class="d-k">Surfaces</span>
            <span class="d-v">
              <span v-for="s in surfaces" :key="s" class="d-surface"><i class="ti" :class="SURFACE_ICON[s]"></i> {{ SURFACE_LABEL[s] }}</span>
              <span class="d-dim">· {{ SOURCE_LABEL[a.stateSource ?? "inferred"] }}</span>
            </span>
          </div>
          <div class="d-row"><span class="d-k">Last event</span><span class="d-v">{{ a.lastEventSummary || "—" }}</span></div>
          <div class="d-row"><span class="d-k">Context</span><span class="d-v">{{ ctx }}</span></div>
          <div v-if="a.pr" class="d-row">
            <span class="d-k">PR</span>
            <span class="d-v">
              <a :href="a.pr.url" target="_blank" rel="noreferrer" class="d-link">#{{ a.pr.number }}</a>
              {{ a.pr.state.toLowerCase() }}<template v-if="a.pr.isDraft"> · draft</template><template v-if="a.pr.reviewDecision"> · {{ a.pr.reviewDecision.toLowerCase().replace(/_/g, " ") }}</template>
              <template v-if="a.pr.title"> — {{ a.pr.title }}</template>
            </span>
          </div>
          <div v-if="dev" class="d-row">
            <span class="d-k">Dev server</span>
            <span class="d-v">
              <span class="mono">:{{ dev.port }}</span>
              <span v-if="dev.candidates.length > 1" class="d-dim"> (+{{ dev.candidates.length - 1 }} more: {{ dev.candidates.filter((c) => c.port !== dev!.port).map((c) => ":" + c.port).join(", ") }})</span>
              <span v-if="devSummary" class="d-dim"> · {{ devSummary }}</span>
            </span>
          </div>
          <div v-if="a.devCommand" class="d-row"><span class="d-k">Dev command</span><span class="d-v mono">{{ a.devCommand }}</span></div>
          <div class="d-row"><span class="d-k">First seen</span><span class="d-v">{{ abs(a.firstSeenAt) }}</span></div>
          <div class="d-row"><span class="d-k">Last activity</span><span class="d-v">{{ abs(a.lastActivityAt) }}</span></div>
          <div class="d-row"><span class="d-k">Session</span><span class="d-v mono d-dim">{{ a.id }}</span></div>
        </div>

        <div class="d-foot">
          <button class="d-open" @click="emit('open', a.id)"><i class="ti ti-external-link"></i> Open window</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.d-overlay { position: fixed; inset: 0; z-index: 65; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.d-panel { width: min(640px, 94vw); max-height: 82vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.d-h { flex: none; display: flex; align-items: center; gap: 10px; padding: 13px 15px; border-bottom: 0.5px solid var(--border-soft); }
.d-title { font-size: 14px; font-weight: 600; color: var(--text-hi); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.d-badge { font-size: 10px; padding: 1px 7px; border-radius: 6px; white-space: nowrap; flex: none; }
.d-h .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.d-h .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.d-body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 15px 12px; }
.d-row { display: grid; grid-template-columns: 108px 1fr; gap: 12px; padding: 7px 0; border-bottom: 0.5px solid var(--border-soft); font-size: 12px; align-items: baseline; }
.d-row:last-child { border-bottom: 0; }
.d-k { color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; padding-top: 2px; }
.d-v { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.d-v.mono, .d-v .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 11px; }
.d-dim { color: var(--text-dim); }
.d-surface { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
.d-link { color: var(--blue); text-decoration: none; }
.d-link:hover { text-decoration: underline; }
.d-foot { flex: none; display: flex; justify-content: flex-end; gap: 8px; padding: 11px 15px; border-top: 0.5px solid var(--border-soft); }
.d-open { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text); background: var(--chip); border: 0.5px solid var(--border); border-radius: 7px; padding: 5px 11px; cursor: pointer; }
.d-open:hover { border-color: var(--gray); color: var(--text-hi); }
</style>
