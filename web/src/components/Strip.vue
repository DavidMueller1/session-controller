<script setup lang="ts">
import { computed, ref, nextTick, onBeforeUnmount } from "vue";
import type { Aircraft } from "../types";
import { STATE, LANDED_COLOR, PARKED_COLOR, isParked, isFlashing, isMia, formatAge, projectName, devUrl } from "../format";
import DevLogs from "./DevLogs.vue";
import StripDetail from "./StripDetail.vue";

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
const spineColor = computed(() => (landed.value ? LANDED_COLOR : parked.value ? PARKED_COLOR : meta.value.color));

// clicking the strip body (anywhere that isn't a control) opens the detail view
const detailOpen = ref(false);
function onStripClick(e: MouseEvent) {
  if ((e.target as HTMLElement).closest("button, a, input")) return; // let controls act
  detailOpen.value = true;
}

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

// dev server(s) detected listening in this strip's folder (Phase 1: detection-only)
const dev = computed(() => props.aircraft.devServer ?? null);
const candidates = computed(() => dev.value?.candidates ?? []);
const hasMenu = computed(() => candidates.value.length > 1);
const portUrl = (p: number) => devUrl(dev.value?.urlTemplate, p);
const devTitle = computed(() => {
  const d = dev.value;
  if (!d) return "";
  return hasMenu.value
    ? `best guess :${d.port} — ${candidates.value.length} servers in this folder · click to list`
    : `dev server on :${d.port} → ${portUrl(d.port)} · click to open`;
});
// a coloured dot per role, matching the popover legend
const roleColor: Record<string, string> = {
  app: "var(--green)",
  api: "var(--blue)",
  hmr: "var(--text-faint)",
  storybook: "var(--text-faint)",
  unknown: "var(--gray)",
};

// two teleported popovers (so the strip's overflow:hidden can't clip them): the port
// candidate list, and the dev-actions dropdown. Both share one dismiss handler.
const portMenu = ref(false);
const actMenu = ref(false);
const portMenuPos = ref({ x: 0, y: 0 });
const actMenuPos = ref({ x: 0, y: 0 });
const portMenuEl = ref<HTMLElement | null>(null);
const actMenuEl = ref<HTMLElement | null>(null);
// After the teleported menu renders, measure it and keep it on-screen: flip above the
// trigger if it would overflow the bottom (the Landed lane sits at the screen edge), and
// clamp to the right edge. Runs in nextTick because we need the menu's real size.
function placeMenu(rect: DOMRect, el: HTMLElement | null, posRef: { value: { x: number; y: number } }) {
  const mh = el?.offsetHeight ?? 0;
  const mw = el?.offsetWidth ?? 220;
  const m = 8; // viewport margin
  let y = rect.bottom + 4;
  if (y + mh > window.innerHeight - m) {
    const above = rect.top - mh - 4;
    y = above >= m ? above : Math.max(m, window.innerHeight - mh - m);
  }
  let x = rect.left;
  if (x + mw > window.innerWidth - m) x = Math.max(m, window.innerWidth - mw - m);
  posRef.value = { x: Math.round(x), y: Math.round(y) };
}
function togglePort(e: MouseEvent) {
  const open = !portMenu.value;
  closeMenus();
  if (open) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    portMenuPos.value = { x: Math.round(r.left), y: Math.round(r.bottom + 4) };
    portMenu.value = true;
    nextTick(() => { placeMenu(r, portMenuEl.value, portMenuPos); addDismiss(); });
  }
}
function toggleAct(e: MouseEvent) {
  const open = !actMenu.value;
  closeMenus();
  if (open) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    actMenuPos.value = { x: Math.round(r.left), y: Math.round(r.bottom + 4) };
    actMenu.value = true;
    nextTick(() => { placeMenu(r, actMenuEl.value, actMenuPos); addDismiss(); });
  }
}
function openPort(p: number) {
  window.open(portUrl(p), "_blank", "noreferrer");
  closeMenus();
}
function closeMenus() {
  portMenu.value = false;
  actMenu.value = false;
  removeDismiss();
}
function onDocClick(e: MouseEvent) {
  if (!(e.target as HTMLElement).closest(".dev-menu, .dev, .act-trigger")) closeMenus();
}
function addDismiss() {
  document.addEventListener("click", onDocClick, true);
  window.addEventListener("scroll", closeMenus, true);
  window.addEventListener("resize", closeMenus, true);
}
function removeDismiss() {
  document.removeEventListener("click", onDocClick, true);
  window.removeEventListener("scroll", closeMenus, true);
  window.removeEventListener("resize", closeMenus, true);
}
onBeforeUnmount(removeDismiss);
const prTitle = computed(() => {
  const p = pr.value;
  if (!p) return "";
  const bits = [p.state.toLowerCase()];
  if (p.isDraft) bits.push("draft");
  if (p.reviewDecision) bits.push(p.reviewDecision.toLowerCase().replace(/_/g, " "));
  return `${bits.join(" · ")}${p.title ? " — " + p.title : ""}`;
});

// managed dev server (Phase 2) — Start when a command is configured, Stop + logs when running
const devManaged = computed(() => props.aircraft.devManaged ?? null);
const devCommand = computed(() => props.aircraft.devCommand ?? null);
const devExit = computed(() => props.aircraft.devExit ?? null);
const devInstall = computed(() => props.aircraft.devInstall ?? null);
const installFailed = computed(() => {
  const i = devInstall.value;
  return !!i && !i.running && i.code != null && i.code !== 0;
});
const installing = computed(() => !!devInstall.value?.running);
// show the dev-actions dropdown for any repo strip (install is always available there)
const hasDev = computed(() => !!(devInstall.value || devManaged.value || devCommand.value || devExit.value));
const devBusy = ref(false);
// which log the panel shows (null = closed) — the dev server, or the install output
const logs = ref<null | "server" | "install">(null);
async function devAction(verb: "start" | "stop" | "install") {
  if (verb === "install") logs.value = "install"; // open the panel to watch install output
  devBusy.value = true;
  try {
    const res = await fetch(`/api/aircraft/${props.aircraft.id}/dev/${verb}`, { method: "POST" });
    // a start that fails (exited on startup, no command, spawn error) → open the logs panel
    // so the reason is visible instead of the button silently doing nothing
    if (verb === "start" && !res.ok) logs.value = "server";
  } catch {
    /* board otherwise reflects the result via the WS update */
  } finally {
    devBusy.value = false;
  }
}

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
  <div class="strip" :class="{ flash: flashing, parked, landed, mia }" :data-fid="aircraft.id" title="Click for details" @click="onStripClick">
    <div class="spine" :style="{ background: spineColor }"></div>
    <div class="body">
      <div class="cs">
        <span class="title" title="Open the session's window (terminal / PhpStorm / Claude)" @click.stop="emit('open', aircraft.id)">{{ aircraft.title || aircraft.id }}</span>
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
        </div>

        <div class="foot">
          <a v-if="pr" class="pr" :href="pr.url" target="_blank" rel="noreferrer" :style="{ color: prColor, borderColor: prColor }" :title="prTitle">
            <i class="ti" :class="prIcon"></i>#{{ pr.number }}
          </a>
          <a v-if="dev && !hasMenu" class="dev" :href="portUrl(dev.port)" target="_blank" rel="noreferrer" :title="devTitle">
            <span class="dot"></span>:{{ dev.port }}
          </a>
          <button v-else-if="dev" class="dev" :title="devTitle" @click.stop="togglePort">
            <span class="dot"></span>:{{ dev.port }}<span class="more">+{{ candidates.length - 1 }}</span><i class="ti ti-chevron-down caret"></i>
          </button>
          <span class="age" :style="{ color: landed ? LANDED_COLOR : parked ? PARKED_COLOR : meta.color }">{{ age }}</span>
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
        <button v-if="!aircraft.note && !editing" class="ghost" @click="openNote"><i class="ti ti-plus"></i> note</button>

        <!-- dev-server & install actions, collapsed into one dropdown to keep the row tidy.
             Trigger colour hints state: green = running, red = install failed / crashed. -->
        <button
          v-if="hasDev"
          class="ghost act-trigger"
          :class="{ running: devManaged, alert: installFailed || (devExit && !devManaged) }"
          :disabled="devBusy"
          title="Dev server & dependencies"
          @click.stop="toggleAct"
        >
          <i class="ti" :class="installing ? 'ti-loader-2 spin' : devManaged ? 'ti-player-stop' : 'ti-server-2'"></i>
          dev<i class="ti ti-chevron-down caret"></i>
        </button>

        <button v-if="!landed" class="ghost land" title="Mark landed" @click="emit('land', aircraft.id)">
          <i class="ti ti-plane-arrival"></i> land
        </button>
      </div>
    </div>
  </div>

  <DevLogs
    v-if="logs"
    :aircraft-id="aircraft.id"
    :title="(aircraft.title || aircraft.id) + (logs === 'install' ? ' · install' : '')"
    :port="logs === 'server' ? (dev?.port ?? null) : null"
    :kind="logs"
    @close="logs = null"
  />

  <StripDetail v-if="detailOpen" :aircraft="aircraft" :now="now" @close="detailOpen = false" @open="emit('open', aircraft.id)" />

  <Teleport to="body">
    <div v-if="portMenu && dev" ref="portMenuEl" class="dev-menu" :style="{ left: portMenuPos.x + 'px', top: portMenuPos.y + 'px' }">
      <div class="dev-menu-h">dev servers in this folder</div>
      <button v-for="c in candidates" :key="c.port" class="dev-row" :class="{ best: c.port === dev.port }" @click="openPort(c.port)">
        <span class="rdot" :style="{ background: roleColor[c.role] }"></span>
        <span class="rp">:{{ c.port }}</span>
        <span class="rl">{{ c.label }}</span>
        <span v-if="c.port === dev.port" class="rbest">best guess</span>
        <i class="ti ti-external-link rx"></i>
      </button>
    </div>
  </Teleport>

  <Teleport to="body">
    <div v-if="actMenu" ref="actMenuEl" class="dev-menu act-menu" :style="{ left: actMenuPos.x + 'px', top: actMenuPos.y + 'px' }">
      <!-- install deps -->
      <button
        v-if="devInstall"
        class="dev-row"
        @click="closeMenus(); installing ? (logs = 'install') : devAction('install')"
      >
        <i class="ti" :class="installing ? 'ti-loader-2 spin' : installFailed ? 'ti-alert-triangle' : 'ti-download'" :style="installFailed ? { color: 'var(--red)' } : {}"></i>
        <span class="rl">{{ installing ? "Installing… — view log" : installFailed ? "Reinstall (last failed)" : "Install dependencies" }}</span>
      </button>
      <!-- start / stop -->
      <button v-if="devManaged" class="dev-row" @click="closeMenus(); devAction('stop')">
        <i class="ti ti-player-stop" style="color: var(--red)"></i>
        <span class="rl">Stop dev server</span>
      </button>
      <button v-else-if="devCommand" class="dev-row" @click="closeMenus(); devAction('start')">
        <i class="ti ti-player-play" style="color: var(--green)"></i>
        <span class="rl">{{ devExit ? "Restart dev server" : "Start dev server" }}</span>
      </button>
      <!-- dev server log -->
      <button v-if="devManaged || devExit" class="dev-row" @click="closeMenus(); logs = 'server'">
        <i class="ti ti-terminal-2" :style="devExit && !devManaged ? { color: 'var(--red)' } : {}"></i>
        <span class="rl">{{ devExit && !devManaged ? "Dev log (crashed)" : "Dev server log" }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.strip { display: flex; background: var(--strip); border: 0.5px solid var(--border); border-radius: 8px; overflow: hidden; animation: strip-in 0.3s ease; cursor: pointer; transition: background-color 0.12s ease; }
.strip.parked { background: var(--strip-parked); }
/* the strip body opens its detail on click — a faint lift on hover hints at that. a
   translucent layer over the base colour, so it brightens every variant without replacing
   it. Suppressed while hovering an interactive child (title, note, buttons, links), since
   those have their own action and don't open the modal. */
.strip:hover:not(:has(button:hover, a:hover, input:hover, .title:hover)) {
  background-image: linear-gradient(rgba(255, 255, 255, 0.05), rgba(255, 255, 255, 0.05));
}
.strip.flash { animation: flash 1s ease-in-out infinite; }
.strip.landed { opacity: 0.9; }
.strip.mia { opacity: 0.7; }
.spine { width: 4px; flex: none; }
.body { flex: 1; min-width: 0; min-height: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cs { display: flex; align-items: center; gap: 6px; flex: none; }
/* the variable-length middle; it (not the buttons) clips when the strip is height-capped */
.mid { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 4px; }
.actions { flex: none; }
.title { font-size: 13px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; cursor: pointer; }
.title:hover { text-decoration: underline; text-decoration-color: var(--gray); text-underline-offset: 2px; }
.ctx { width: 16px; height: 16px; flex: none; margin-left: auto; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; flex: none; display: inline-flex; align-items: center; gap: 3px; }
.badge.dim { background: #1c222c; color: #8b98a8; }
.badge-x { all: unset; cursor: pointer; display: inline-flex; margin-left: 3px; opacity: 0.7; }
.badge-x:hover { opacity: 1; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; color: var(--text-dim); background: var(--chip); border-radius: 6px; padding: 1px 6px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); }
.foot .age { margin-left: auto; font-weight: 500; }
.pr { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; border: 0.5px solid; border-radius: 6px; padding: 0 5px; text-decoration: none; }
.dev { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; color: var(--green); border: 0.5px solid color-mix(in srgb, var(--green) 40%, transparent); border-radius: 6px; padding: 0 5px; text-decoration: none; background: transparent; cursor: pointer; }
.dev:hover { border-color: var(--green); }
.dev .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); box-shadow: 0 0 5px color-mix(in srgb, var(--green) 70%, transparent); }
.dev .more { color: var(--text-faint); }
.dev .caret { font-size: 12px; margin-left: -1px; opacity: 0.7; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
/* a note is what parks a strip, so the pill wears the Parked colour */
.note { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; background: var(--parked-bg); color: var(--parked); border-radius: 6px; padding: 2px 4px 2px 7px; }
.icon { all: unset; cursor: pointer; display: inline-flex; align-items: center; padding: 2px; margin-left: 2px; border-radius: 4px; font-size: 13px; }
.icon:hover { background: rgba(255, 255, 255, 0.1); }
.note-input { font-size: 11px; height: 26px; width: 100%; }
.ghost { font-size: 11px; color: var(--text-faint); border: 0.5px dashed var(--border); border-radius: 6px; padding: 1px 7px; background: transparent; display: inline-flex; align-items: center; gap: 4px; }
.ghost:hover { color: var(--text-dim); border-color: var(--gray); }
.ghost.land:hover { color: #4cc38a; border-color: #2f6f4f; }
.ghost:disabled { opacity: 0.5; cursor: default; }
.act-trigger .caret { font-size: 12px; margin-left: -1px; opacity: 0.7; }
.act-trigger.running { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.act-trigger.alert { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }
.ghost .spin { animation: ghost-spin 0.9s linear infinite; }
@keyframes ghost-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ghost .spin { animation: none; } }
@media (prefers-reduced-motion: reduce) {
  .strip.flash { animation: none; background: var(--amber-bg); }
}

/* teleported to <body> — fixed so the strip's overflow:hidden can't clip it */
.dev-menu { position: fixed; z-index: 50; min-width: 210px; max-width: 320px; background: var(--panel); border: 0.5px solid var(--border); border-radius: 8px; padding: 4px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5); }
.dev-menu-h { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); padding: 4px 7px 5px; }
.dev-row { display: flex; align-items: center; gap: 7px; width: 100%; background: transparent; border: 0; border-radius: 6px; padding: 5px 7px; cursor: pointer; text-align: left; color: var(--text); }
.dev-row:hover { background: var(--chip); }
.dev-row .rdot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.dev-row .rp { font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace; font-size: 12px; color: var(--text-hi); }
.dev-row .rl { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; }
.dev-row .rbest { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--green); border: 0.5px solid color-mix(in srgb, var(--green) 45%, transparent); border-radius: 5px; padding: 1px 4px; flex: none; }
.dev-row .rx { font-size: 12px; color: var(--text-faint); flex: none; opacity: 0; }
.dev-row:hover .rx { opacity: 1; }
</style>
