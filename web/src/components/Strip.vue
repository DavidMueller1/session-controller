<script setup lang="ts">
import { computed, ref, nextTick } from "vue";
import type { Aircraft } from "../types";
import { STATE, LANDED_COLOR, PARKED_COLOR, isParked, isFlashing, isMia, formatAge, projectName } from "../format";

const props = defineProps<{ aircraft: Aircraft; now: number }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
  open: [id: string];
}>();

const meta = computed(() => STATE[props.aircraft.state]);
const landed = computed(() => !!props.aircraft.landed);
const parked = computed(() => isParked(props.aircraft) && !landed.value);
const flashing = computed(() => isFlashing(props.aircraft) && !landed.value);
const mia = computed(() => isMia(props.aircraft));
// "Approach" is now a flag (merged PR → ready to land), not a lane — a badge that can ride
// on any non-landed strip, alongside its state badge (e.g. Needs you + Approach).
const approaching = computed(() => !!props.aircraft.approach && !landed.value);
// time in current state (reset only on state change), not time since last event
const age = computed(() => {
  const since = props.aircraft.stateSince ?? props.aircraft.lastActivityAt;
  return formatAge(since ? props.now - since : null);
});
const surfaces = computed(() => props.aircraft.surfaces ?? [props.aircraft.source]);

// signal source → a plain-English label, surfaced only on hover of the surface icons
// so you can tell which sessions are on the slow inferred path vs. the live signals.
const SOURCE_LABEL: Record<string, string> = {
  hook: "live via hooks",
  registry: "live via Claude Code registry",
  inferred: "inferred from transcript (≈8s delay)",
};
const surfaceTitle = computed(() => `state ${SOURCE_LABEL[props.aircraft.stateSource ?? "inferred"]}`);
const spineColor = computed(() => (landed.value ? LANDED_COLOR : parked.value ? PARKED_COLOR : meta.value.color));

// context-usage ring
const ctxPct = computed(() => props.aircraft.contextPct ?? null);
const CTX_R = 7;
const CTX_CIRC = 2 * Math.PI * CTX_R;
const ctxOffset = computed(() => CTX_CIRC * (1 - (ctxPct.value ?? 0)));
const ctxColor = computed(() => {
  const p = ctxPct.value ?? 0;
  return p >= 0.9 ? "var(--red)" : p >= 0.75 ? "var(--amber)" : "#5f6b7a";
});
const ctxTitle = computed(() => {
  if (ctxPct.value == null) return "";
  return `${Math.round(ctxPct.value * 100)}% context used (${(props.aircraft.contextTokens ?? 0).toLocaleString()} tokens)`;
});

// PR pill
const pr = computed(() => props.aircraft.pr ?? null);
const prColor = computed(() => {
  const p = pr.value;
  if (!p) return "";
  if (p.state === "MERGED") return "#a371f7";
  if (p.state === "CLOSED") return "#f85149";
  if (p.isDraft) return "#7d8590";
  if (p.reviewDecision === "APPROVED") return "#3fb950";
  if (p.reviewDecision === "REVIEW_REQUIRED" || p.reviewDecision === "CHANGES_REQUESTED") return "#e0a92e";
  return "#58a6ff";
});
const prIcon = computed(() => (pr.value?.state === "MERGED" ? "ti-git-merge" : "ti-git-pull-request"));
const prTitle = computed(() => {
  const p = pr.value;
  if (!p) return "";
  const bits = [p.state.toLowerCase()];
  if (p.isDraft) bits.push("draft");
  if (p.reviewDecision) bits.push(p.reviewDecision.toLowerCase().replace(/_/g, " "));
  return `${bits.join(" · ")}${p.title ? " — " + p.title : ""}`;
});

const editing = ref(false);
const draft = ref("");
const inputEl = ref<HTMLInputElement | null>(null);

async function openNote() {
  editing.value = true;
  draft.value = props.aircraft.note ?? "";
  await nextTick();
  inputEl.value?.focus();
}
function commitNote() {
  const v = draft.value.trim();
  editing.value = false;
  if (v) emit("setNote", props.aircraft.id, v);
}
</script>

<template>
  <div class="strip" :class="{ flash: flashing, parked, landed, mia }" :data-fid="aircraft.id">
    <div class="spine" :style="{ background: spineColor }"></div>
    <div class="body">
      <div class="cs">
        <span class="title" role="button" tabindex="0" title="Open this session's window" @click="emit('open', aircraft.id)" @keydown.enter="emit('open', aircraft.id)">{{ aircraft.title || aircraft.id }}</span>
        <span v-if="landed" class="badge" style="background: #16301f; color: #4cc38a"><i class="ti ti-check"></i> Landed<button class="badge-x" aria-label="undo landing" title="undo landing" @click="emit('unland', aircraft.id)"><i class="ti ti-x"></i></button></span>
        <span v-else-if="mia" class="badge" style="background: #1c222c; color: #8b98a8" title="no activity for 5+ min — still flying, but lost contact"><i class="ti ti-clock"></i> MIA</span>
        <span v-else-if="parked" class="badge" style="background: var(--parked-bg); color: var(--parked)"><i class="ti ti-parking"></i> Parked</span>
        <span
          v-else-if="aircraft.state === 'needs-input' || aircraft.state === 'error'"
          class="badge"
          :style="{ background: meta.color, color: 'var(--bg)' }"
        >{{ meta.label }}</span>
        <span
          v-else-if="aircraft.state === 'suspected-done' || aircraft.state === 'dormant' || aircraft.state === 'unknown'"
          class="badge dim"
          :title="'lost contact — ' + meta.label.toLowerCase()"
        >{{ meta.label }}</span>
        <!-- Approach rides alongside the state badge: a merged PR ready to land -->
        <span v-if="approaching" class="badge" style="background: rgba(88,166,255,0.14); color: var(--blue)" title="merged PR — cleared to land"><i class="ti ti-plane-inflight"></i> Approach</span>
        <svg v-if="ctxPct != null" class="ctx" viewBox="0 0 18 18" :aria-label="ctxTitle"><title>{{ ctxTitle }}</title>
          <circle cx="9" cy="9" :r="CTX_R" fill="none" stroke="var(--border)" stroke-width="2.5" />
          <circle cx="9" cy="9" :r="CTX_R" fill="none" :stroke="ctxColor" stroke-width="2.5" stroke-linecap="round"
            :stroke-dasharray="CTX_CIRC" :stroke-dashoffset="ctxOffset" transform="rotate(-90 9 9)" />
        </svg>
      </div>

      <!-- middle content clips first when the strip is height-constrained (flight layer),
           so the title (above) and the action buttons (below) are always visible -->
      <div class="mid">
        <div class="chips">
          <span class="chip mono">{{ projectName(aircraft.project) }}</span>
          <span v-if="aircraft.branch" class="chip mono"><i class="ti ti-git-branch"></i> {{ aircraft.branch }}</span>
          <span v-if="aircraft.model" class="chip mono">{{ aircraft.model }}</span>
        </div>

        <div class="act">{{ aircraft.lastEventSummary }}</div>

        <div class="foot">
          <i v-if="surfaces.includes('cli')" class="ti ti-terminal-2" :title="'terminal · ' + surfaceTitle"></i>
          <i v-if="surfaces.includes('desktop')" class="ti ti-device-desktop" :title="'desktop · ' + surfaceTitle"></i>
          <a v-if="pr" class="pr" :href="pr.url" target="_blank" rel="noreferrer" :style="{ color: prColor, borderColor: prColor }" :title="prTitle">
            <i class="ti" :class="prIcon"></i>#{{ pr.number }}
          </a>
          <span class="age" :style="{ color: landed ? LANDED_COLOR : meta.color }">{{ age }}</span>
        </div>
      </div>

      <div class="actions">
        <span v-if="aircraft.note && !editing" class="note">
          <i class="ti ti-pin"></i>
          <span>{{ aircraft.note }}</span>
          <button class="icon" aria-label="remove note" @click="emit('removeNote', aircraft.id)"><i class="ti ti-x"></i></button>
        </span>
        <input
          v-if="editing"
          ref="inputEl"
          v-model="draft"
          class="note-input"
          placeholder="note… e.g. waiting on Anna"
          @keydown.enter="commitNote"
          @keydown.esc="editing = false"
          @blur="commitNote"
        />
        <button class="ghost" title="Open this session's window" @click="emit('open', aircraft.id)"><i class="ti ti-external-link"></i> open</button>
        <button v-if="!aircraft.note && !editing" class="ghost" @click="openNote"><i class="ti ti-plus"></i> note</button>

        <button v-if="!landed" class="ghost land" title="Mark landed" @click="emit('land', aircraft.id)">
          <i class="ti ti-plane-arrival"></i> land
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip { display: flex; background: var(--strip); border: 0.5px solid var(--border); border-radius: 8px; overflow: hidden; animation: strip-in 0.3s ease; }
.strip.parked { background: var(--strip-parked); }
.strip.flash { animation: flash 1s ease-in-out infinite; }
.strip.landed { opacity: 0.9; }
.strip.mia { opacity: 0.7; }
.spine { width: 4px; flex: none; }
.body { flex: 1; min-width: 0; min-height: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cs { display: flex; align-items: center; gap: 6px; flex: none; }
/* the variable-length middle; it (not the buttons) clips when the strip is height-capped */
.mid { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 4px; }
.actions { flex: none; }
.title { font-size: 13px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; min-width: 0; }
.ctx { width: 16px; height: 16px; flex: none; margin-left: auto; }
.title:hover { text-decoration: underline; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; flex: none; display: inline-flex; align-items: center; gap: 3px; }
.badge.dim { background: #1c222c; color: #8b98a8; }
.badge-x { all: unset; cursor: pointer; display: inline-flex; margin-left: 3px; opacity: 0.7; }
.badge-x:hover { opacity: 1; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; color: var(--text-dim); background: var(--chip); border-radius: 6px; padding: 1px 6px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); }
.foot .age { margin-left: auto; font-weight: 500; }
.pr { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; border: 0.5px solid; border-radius: 6px; padding: 0 5px; text-decoration: none; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
/* a note is what parks a strip, so the pill wears the Parked colour */
.note { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; background: var(--parked-bg); color: var(--parked); border-radius: 6px; padding: 2px 4px 2px 7px; }
.icon { all: unset; cursor: pointer; display: inline-flex; align-items: center; padding: 2px; margin-left: 2px; border-radius: 4px; font-size: 13px; }
.icon:hover { background: rgba(255, 255, 255, 0.1); }
.note-input { font-size: 11px; height: 26px; width: 100%; }
.ghost { font-size: 11px; color: var(--text-faint); border: 0.5px dashed var(--border); border-radius: 6px; padding: 1px 7px; background: transparent; display: inline-flex; align-items: center; gap: 4px; }
.ghost:hover { color: var(--text-dim); border-color: var(--gray); }
.ghost.land:hover { color: #4cc38a; border-color: #2f6f4f; }
@media (prefers-reduced-motion: reduce) {
  .strip.flash { animation: none; background: var(--amber-bg); }
}
</style>
