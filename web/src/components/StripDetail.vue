<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { Aircraft } from "../types";
import { STATE, formatAge, laneOf, devUrl, isParked, LANDED_COLOR, PARKED_COLOR } from "../format";

const props = defineProps<{ aircraft: Aircraft; now: number }>();
const emit = defineEmits<{ close: []; open: [id: string] }>();

// One knob for the whole open/close animation. Feeds both the CSS `--dur` (all keyframes)
// and the Transition duration (when Vue fires @after-leave). Bump it up to study the motion.
const DUR = 580;

// Open plays the enter animation; closing flips `visible` off so the SAME animation plays
// in reverse (Transition leave), and we tell the parent to unmount only after it finishes.
const visible = ref(true);
const reduceMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
function requestClose() {
  if (reduceMotion) emit("close");
  else visible.value = false;
}

const onKey = (e: KeyboardEvent) => {
  if (e.key === "Escape") requestClose();
};
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => window.removeEventListener("keydown", onKey));

const a = computed(() => props.aircraft);
// landed / parked are overlays on top of the raw activity state — reflect them in the badge
// and accent colour, matching how the strip itself is labelled (see laneOf/isParked).
const meta = computed(() => {
  if (a.value.landed) return { label: "Landed", color: LANDED_COLOR };
  if (isParked(a.value)) return { label: "Parked", color: PARKED_COLOR };
  return STATE[a.value.state];
});
const title = computed(() => a.value.title || a.value.id);

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
const portUrl = (p: number) => devUrl(dev.value?.urlTemplate, p);
// up to three dev servers as clickable links (best guess first); the rest summarised as "+N"
const MAX_DEV_LINKS = 3;
const devPorts = computed(() => {
  const d = dev.value;
  if (!d) return [];
  const cs = d.candidates?.length ? d.candidates.map((c) => c.port) : [d.port];
  return [...cs.filter((p) => p === d.port), ...cs.filter((p) => p !== d.port)];
});
const devShown = computed(() => devPorts.value.slice(0, MAX_DEV_LINKS));
const devExtra = computed(() => Math.max(0, devPorts.value.length - MAX_DEV_LINKS));
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
    <Transition appear :duration="{ enter: DUR, leave: DUR }" @after-leave="emit('close')">
      <div v-if="visible" class="d-overlay" :style="{ '--dur': DUR + 'ms' }" @click.self="requestClose">
        <div class="d-binder" :style="{ '--accent': meta.color }">
        <div class="d-pages">
          <!-- LEFT: the cover. front face = engraved title (shut); inside = the title page -->
          <div class="d-cover">
            <div class="d-face d-front"><span class="d-engrave">{{ title }}</span></div>
            <div class="d-face d-inside">
              <span class="d-badge" :style="{ background: meta.color, color: 'var(--bg)' }">{{ meta.label }}</span>
              <div class="d-tp-title">{{ title }}</div>
              <div class="d-tp-block">
                <div class="d-tp-row"><span class="d-k">Project</span><span class="d-v mono">{{ a.project || "—" }}</span></div>
                <div class="d-tp-row"><span class="d-k">Branch</span><span class="d-v mono">{{ a.branch || "—" }}</span></div>
                <div class="d-tp-row"><span class="d-k">Model</span><span class="d-v mono">{{ a.model || "—" }}</span></div>
                <div class="d-tp-row"><span class="d-k">Context</span><span class="d-v">{{ ctx }}</span></div>
              </div>
              <div class="d-tp-id mono">{{ a.id }}</div>
            </div>
          </div>

          <!-- RIGHT: the detail page (hidden under the shut cover, revealed as it opens) -->
          <div class="d-base">
            <button class="d-x" aria-label="close" @click="requestClose"><i class="ti ti-x"></i></button>
            <div class="d-scroll">
              <section class="d-sec">
                <div class="d-sec-h"><i class="ti ti-plane-inflight"></i>Status</div>
                <div class="d-row"><span class="d-k">State</span><span class="d-v">{{ meta.label }} · {{ laneOf(a) }} lane · {{ inState }} in state</span></div>
              </section>

              <section class="d-sec">
                <div class="d-sec-h"><i class="ti ti-activity"></i>Activity</div>
                <div class="d-row">
                  <span class="d-k">Surfaces</span>
                  <span class="d-v">
                    <span v-for="s in surfaces" :key="s" class="d-surface"><i class="ti" :class="SURFACE_ICON[s]"></i> {{ SURFACE_LABEL[s] }}</span>
                    <span class="d-dim">· {{ SOURCE_LABEL[a.stateSource ?? "inferred"] }}</span>
                  </span>
                </div>
                <div class="d-row"><span class="d-k">Last event</span><span class="d-v">{{ a.lastEventSummary || "—" }}</span></div>
              </section>

              <section v-if="a.pr || dev || a.devCommand" class="d-sec">
                <div class="d-sec-h"><i class="ti ti-link"></i>Links</div>
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
                    <a
                      v-for="p in devShown"
                      :key="p"
                      class="d-port"
                      :class="{ best: p === dev.port }"
                      :href="portUrl(p)"
                      target="_blank"
                      rel="noreferrer"
                      :title="`open :${p} → ${portUrl(p)}`"
                    >:{{ p }}</a>
                    <span v-if="devExtra" class="d-dim">+{{ devExtra }} more</span>
                    <span v-if="devSummary" class="d-dim"> · {{ devSummary }}</span>
                  </span>
                </div>
                <div v-if="a.devCommand" class="d-row"><span class="d-k">Dev command</span><span class="d-v mono">{{ a.devCommand }}</span></div>
              </section>

              <section class="d-sec">
                <div class="d-sec-h"><i class="ti ti-clock"></i>Timeline</div>
                <div class="d-row"><span class="d-k">First seen</span><span class="d-v">{{ abs(a.firstSeenAt) }}</span></div>
                <div class="d-row"><span class="d-k">Last activity</span><span class="d-v">{{ abs(a.lastActivityAt) }}</span></div>
              </section>
            </div>

            <div class="d-foot">
              <button class="d-open" @click="emit('open', a.id)"><i class="ti ti-external-link"></i> Open window</button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.d-overlay { --dur: 760ms; position: fixed; inset: 0; z-index: 65; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }

/* the binder holds the perspective; it drops in from the viewer on open */
.d-binder { position: relative; width: min(760px, 96vw); perspective: 1600px; perspective-origin: 50% 24%; transform-origin: center center; }
/* fixed height so the binder never resizes as a session's live state changes (a PR
   appears, last-event text grows, a dev server shows up); the right page scrolls instead */
.d-pages { position: relative; display: grid; grid-template-columns: 1fr 1fr; align-items: stretch; height: min(560px, 86vh); transform-style: preserve-3d; }

/* LEFT cover: two faces; flips open from the centre gutter */
.d-cover { grid-column: 1; grid-row: 1; position: relative; transform-origin: right center; transform-style: preserve-3d; z-index: 3; min-height: 240px; }
.d-face { position: absolute; inset: 0; backface-visibility: hidden; border: 0.5px solid var(--border); }
.d-front { transform: rotateY(180deg); border-radius: 12px 3px 3px 12px; background: linear-gradient(145deg, #2b3340, #1a1f27); display: flex; align-items: center; justify-content: center; box-shadow: inset 0 0 46px rgba(0, 0, 0, 0.4); }
.d-engrave { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; text-transform: uppercase; letter-spacing: 0.14em; font-weight: 700; font-size: 15px; color: #0a0c11; text-shadow: 0 1px 0 rgba(255, 255, 255, 0.06), 0 -1px 1px rgba(0, 0, 0, 0.7); text-align: center; padding: 0 26px; line-height: 1.4; }
.d-inside { border-radius: 12px 3px 3px 12px; border-right: none; background: var(--panel); display: flex; flex-direction: column; gap: 9px; padding: 20px 36px 20px 20px; }
.d-tp-title { font-size: 17px; font-weight: 700; color: var(--text-hi); line-height: 1.2; overflow-wrap: anywhere; }
.d-badge { align-self: flex-start; font-size: 10px; font-weight: 600; padding: 1px 8px; border-radius: 6px; white-space: nowrap; }
.d-tp-block { display: flex; flex-direction: column; gap: 5px; margin-top: 2px; }
.d-tp-row { display: grid; grid-template-columns: 62px 1fr; gap: 10px; font-size: 12px; align-items: baseline; }
.d-tp-id { margin-top: auto; font-size: 10px; color: var(--text-faint); overflow-wrap: anywhere; }

/* RIGHT detail page */
/* the left border is the binder's centre line — a plain hairline in the same colour as the
   outline, revealed with the page as the cover opens (no separate spine decoration) */
.d-base { grid-column: 2; grid-row: 1; position: relative; z-index: 1; display: flex; flex-direction: column; min-height: 0; background: var(--panel); border: 0.5px solid var(--border); border-radius: 3px 12px 12px 3px; }
.d-x { all: unset; position: absolute; top: 8px; right: 10px; z-index: 2; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.d-x:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.d-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 15px 8px 36px; }

.d-sec { padding: 8px 0; border-bottom: 0.5px solid var(--border-soft); }
.d-sec:last-child { border-bottom: none; }
.d-sec-h { display: flex; align-items: center; gap: 7px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-faint); margin: 2px 2px 7px; }
.d-sec-h i { font-size: 12px; color: var(--accent); }
.d-row { display: grid; grid-template-columns: 96px 1fr; gap: 12px; padding: 4px 2px; font-size: 12px; align-items: baseline; border-radius: 6px; }
.d-row:hover { background: rgba(255, 255, 255, 0.02); }
.d-k { color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; font-size: 10px; padding-top: 2px; }
.d-v { color: var(--text); min-width: 0; overflow-wrap: anywhere; }
.d-v.mono, .d-v .mono { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 11px; }
.d-dim { color: var(--text-dim); }
.d-port { display: inline-flex; align-items: center; gap: 4px; font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 11px; color: var(--green); text-decoration: none; border: 0.5px solid color-mix(in srgb, var(--green) 40%, transparent); border-radius: 6px; padding: 0 6px; margin-right: 6px; }
.d-port:hover { border-color: var(--green); background: color-mix(in srgb, var(--green) 10%, transparent); }
.d-port.best { background: color-mix(in srgb, var(--green) 12%, transparent); }
.d-surface { display: inline-flex; align-items: center; gap: 4px; margin-right: 10px; }
.d-link { color: var(--blue); text-decoration: none; }
.d-link:hover { text-decoration: underline; }
.d-foot { flex: none; display: flex; justify-content: flex-end; padding: 11px 15px; border-top: 0.5px solid var(--border-soft); }
.d-open { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text); background: var(--chip); border: 0.5px solid var(--border); border-radius: 7px; padding: 5px 11px; cursor: pointer; }
.d-open:hover { border-color: var(--gray); color: var(--text-hi); }

/* enter plays the timeline forward; leave plays the SAME var(--dur) timeline in REVERSE — a
   clean rewind (cover folds shut, base hides, then the binder lifts away and fades) */
.d-overlay.v-enter-active { animation: d-bg var(--dur) ease both; }
.v-enter-active .d-binder { animation: d-drop var(--dur) cubic-bezier(0.2, 0.8, 0.3, 1) both; }
.v-enter-active .d-cover  { animation: d-flip var(--dur) cubic-bezier(0.65, 0, 0.35, 1) both; }
.v-enter-active .d-face   { animation: d-fx var(--dur) ease both; }
.v-enter-active .d-base   { animation: d-reveal var(--dur) ease both; }

.d-overlay.v-leave-active { animation: d-bg var(--dur) ease reverse both; }
.v-leave-active .d-binder { animation: d-drop var(--dur) cubic-bezier(0.2, 0.8, 0.3, 1) reverse both; }
.v-leave-active .d-cover  { animation: d-flip var(--dur) cubic-bezier(0.65, 0, 0.35, 1) reverse both; }
.v-leave-active .d-face   { animation: d-fx var(--dur) ease reverse both; }
.v-leave-active .d-base   { animation: d-reveal var(--dur) ease reverse both; }

@keyframes d-bg { 0% { background: rgba(6, 9, 13, 0); } 20%, 100% { background: rgba(6, 9, 13, 0.66); } }
@keyframes d-drop { 0% { transform: translateY(-24px) scale(1.26); } 40%, 100% { transform: translateY(0) scale(1); } }
@keyframes d-flip { 0%, 8% { transform: rotateY(180deg); } 100% { transform: rotateY(0deg); } }
@keyframes d-fx { 0% { opacity: 0; filter: blur(11px); } 40%, 100% { opacity: 1; filter: blur(0); } }
@keyframes d-reveal { 0%, 38% { opacity: 0; } 46%, 100% { opacity: 1; } }

@media (prefers-reduced-motion: reduce) {
  .d-overlay, .d-overlay * { animation: none !important; }
}
</style>
