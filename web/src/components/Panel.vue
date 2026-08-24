<script setup lang="ts">
import { computed, reactive, onMounted } from "vue";
import Strip from "./Strip.vue";
import { laneOf, isFlashing, projectName } from "../format";
import type { Aircraft } from "../types";

// Compact mini-board for the menu-bar popover. Shares the full board's state and the
// exact same Strip cards, just stacked in one scrolling column and ordered by triage
// priority (who needs you first). All actions bubble up unchanged.
const props = defineProps<{ aircraft: Aircraft[]; now: number; connected: boolean }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
  open: [id: string];
}>();

const orderKey = (a: { stateSince?: number | null; lastActivityAt: number | null }) =>
  a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) =>
  props.aircraft.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));

const holding = computed(() =>
  byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))),
);
const inflight = computed(() => byLane("inflight")); // header count only — not listed
const parked = computed(() => byLane("parked"));

// The panel is a triage view: only what needs you (Holding) and what you've parked.
// In-flight / MIA / landed live in the full dashboard; their totals still show up top.
const sections = computed(() =>
  [
    { key: "holding", label: "Holding", icon: "ti-circle-filled", color: "var(--amber)", list: holding.value, collapsible: false },
    { key: "parked", label: "Parked", icon: "ti-circle-filled", color: "var(--parked)", list: parked.value, collapsible: true },
  ].filter((s) => s.list.length),
);

// Parked starts collapsed — it's already-triaged, so it shouldn't crowd out Holding.
const open = reactive<Record<string, boolean>>({ holding: true, parked: false });
function toggle(key: string) { open[key] = !open[key]; }

const total = computed(() => holding.value.length + parked.value.length);
const dashboardUrl = computed(() => location.origin + "/");
// runtime-bound (not static src="/logo.svg") so Vite doesn't inline+cache a stale SVG in dev
const logoUrl = "/logo.svg";

// Native controls: only when hosted in the menu-bar popover (the webkit bridge exists).
// Each button posts a command the Swift app executes (start/stop/update/quit live there).
const isNative = typeof (window as any).webkit?.messageHandlers?.command !== "undefined";
function cmd(name: string) {
  (window as any).webkit?.messageHandlers?.command?.postMessage(name);
}

// mini in-flight chips: label + hover detail
const miniLabel = (a: Aircraft) => a.title || projectName(a.project) || a.id;
const miniTitle = (a: Aircraft) =>
  [miniLabel(a), a.lastEventSummary].filter(Boolean).join(" · ");

// Report the panel's natural height to the native popover so it sizes to content
// (capped on the Swift side). No-op outside the menu-bar webview.
onMounted(() => {
  const el = document.querySelector(".panel") as HTMLElement | null;
  const bridge = (window as any).webkit?.messageHandlers?.resize;
  if (!el || !bridge) return;
  const post = () => bridge.postMessage(Math.ceil(el.getBoundingClientRect().height));
  new ResizeObserver(post).observe(el);
  post();
});
</script>

<template>
  <div class="panel">
    <header class="p-head">
      <img :src="logoUrl" class="p-logo" alt="" />
      <span class="p-name"><span class="w1">Session</span><span class="w2">Controller</span></span>
      <span class="p-counts">
        <span v-if="holding.length" :style="{ color: 'var(--amber)' }">{{ holding.length }}</span>
        <span v-if="inflight.length" :style="{ color: 'var(--green)' }">{{ inflight.length }}</span>
      </span>
      <span class="p-dot" :style="{ color: connected ? 'var(--green)' : 'var(--red)' }" :title="connected ? 'live' : 'reconnecting'">
        <i class="ti ti-circle-filled"></i>
      </span>
      <a class="p-open" :href="dashboardUrl" target="_blank" rel="noreferrer" title="Open full dashboard">
        <i class="ti ti-external-link"></i>
      </a>
    </header>

    <div class="p-body">
      <div v-if="!inflight.length && !total" class="p-empty">No sessions tracked</div>

      <section v-if="inflight.length" class="p-sec">
        <div class="p-sec-h">
          <i class="ti ti-plane-inflight" :style="{ color: 'var(--green)' }"></i>In-flight
          <span class="n">{{ inflight.length }}</span>
        </div>
        <div class="p-inflight">
          <button
            v-for="a in inflight"
            :key="a.id"
            class="mini"
            :title="miniTitle(a)"
            @click="emit('open', a.id)"
          >
            <span class="mini-spine"></span><span class="mini-name">{{ miniLabel(a) }}</span>
          </button>
        </div>
      </section>

      <div v-if="inflight.length && !total" class="p-empty p-quiet">Nothing else waiting on you</div>

      <section v-for="s in sections" :key="s.key" class="p-sec">
        <div class="p-sec-h" :class="{ clickable: s.collapsible }" @click="s.collapsible && toggle(s.key)">
          <i v-if="s.collapsible" class="ti p-caret" :class="open[s.key] ? 'ti-chevron-down' : 'ti-chevron-right'"></i>
          <i class="ti" :class="s.icon" :style="{ color: s.color }"></i>{{ s.label }}
          <span class="n">{{ s.list.length }}</span>
        </div>
        <div v-show="!s.collapsible || open[s.key]" class="p-stack">
          <Strip
            v-for="a in s.list"
            :key="a.id"
            :aircraft="a"
            :now="now"
            @set-note="(id, n) => emit('setNote', id, n)"
            @remove-note="(id) => emit('removeNote', id)"
            @land="(id) => emit('land', id)"
            @unland="(id) => emit('unland', id)"
            @open="(id) => emit('open', id)"
          />
        </div>
      </section>
    </div>

    <footer v-if="isNative" class="p-foot">
      <span class="foot-hint">right-click the icon for more</span>
      <button class="foot-btn" title="Check for Updates" @click="cmd('update')">
        <i class="ti ti-refresh"></i>
      </button>
      <button class="foot-btn" title="Restart server" @click="cmd('restart')">
        <i class="ti ti-reload"></i>
      </button>
      <button class="foot-btn" title="Stop server" @click="cmd('stop')">
        <i class="ti ti-player-stop"></i>
      </button>
      <button class="foot-btn danger" title="Quit Session Controller" @click="cmd('quit')">
        <i class="ti ti-power"></i>
      </button>
    </footer>
  </div>
</template>

<style scoped>
/* content-height (not 100dvh): the native popover measures .panel and sizes to it, capped */
.panel { display: flex; flex-direction: column; background: var(--bg); color: var(--text); }
.p-head { position: sticky; top: 0; z-index: 2; background: var(--bg); display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border-soft); }
.p-logo { width: 20px; height: 20px; display: block; }
.p-name { display: inline-flex; align-items: baseline; gap: 0.45em; text-transform: uppercase; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 12px; line-height: 1; }
.p-name .w1 { font-weight: 300; letter-spacing: 0.28em; color: var(--text-dim); }
.p-name .w2 { font-weight: 700; letter-spacing: 0.28em; color: var(--text-hi); }
.p-counts { margin-left: auto; display: inline-flex; gap: 10px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.p-dot { display: inline-flex; align-items: center; }
.p-dot i { font-size: 8px; }
.p-open { all: unset; cursor: pointer; color: var(--text-faint); font-size: 14px; padding: 3px; border-radius: 6px; display: inline-flex; }
.p-open:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.p-body { padding: 10px 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.p-sec-h { display: flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 500; color: var(--text); margin-bottom: 6px; }
.p-sec-h i { font-size: 9px; }
.p-sec-h.clickable { cursor: pointer; user-select: none; margin: -2px -4px 4px; padding: 2px 4px; border-radius: 6px; }
.p-sec-h.clickable:hover { background: rgba(255, 255, 255, 0.06); }
.p-caret { font-size: 12px !important; color: var(--text-faint); margin-left: -2px; }
.p-sec-h .n { color: var(--text-faint); font-weight: 400; }
.p-stack { display: flex; flex-direction: column; gap: 8px; }
.p-empty { color: var(--text-faint); font-size: 12px; text-align: center; padding: 30px 0; }
.p-quiet { padding: 0 0 2px; text-align: left; }

/* native controls footer (menu-bar popover only) */
.p-foot { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 4px; padding: 7px 10px; background: var(--bg); border-top: 1px solid var(--border-soft); }
.foot-hint { font-size: 10px; color: var(--text-faint); margin-right: auto; }
.foot-btn { all: unset; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 24px; border-radius: 6px; color: var(--text-dim); font-size: 14px; }
.foot-btn:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-hi); }
.foot-btn.danger:hover { background: color-mix(in srgb, var(--red) 20%, transparent); color: var(--red); }

/* very mini in-flight strips: the real strip look (card + green spine) shrunk down */
.p-inflight { display: flex; flex-wrap: wrap; gap: 6px; }
.mini { all: unset; cursor: pointer; display: inline-flex; align-items: stretch; max-width: 100%; background: var(--strip); border: 0.5px solid var(--border); border-radius: 6px; overflow: hidden; font-size: 11px; color: var(--text-dim); }
.mini:hover { border-color: color-mix(in srgb, var(--green) 45%, var(--border)); color: var(--text-hi); }
.mini-spine { width: 3px; flex: none; background: var(--green); }
.mini-name { padding: 3px 8px; align-self: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
</style>
