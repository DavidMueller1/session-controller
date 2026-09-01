<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount } from "vue";
import { laneOf, isFlashing, projectName, formatAge } from "../format";
import type { Aircraft } from "../types";

// Right-edge rail overlay: normally only the colour-coded spine of each strip peeks at the
// screen edge; hovering the rail flies the full strips in so they can be read. In-flight on
// top, Holding below — nothing else. Meant to live in a transparent always-on-top panel.
const props = defineProps<{ aircraft: Aircraft[]; now: number }>();
const emit = defineEmits<{ open: [id: string] }>();

const LANE_COLOR: Record<string, string> = { inflight: "#3fb950", holding: "#e0a92e" };

const orderKey = (a: Aircraft) => a.stateSince ?? a.lastActivityAt ?? 0;
const byLane = (lane: string) => props.aircraft.filter((a) => laneOf(a) === lane).sort((a, b) => orderKey(b) - orderKey(a));

const inflight = computed(() => byLane("inflight"));
// most urgent (flashing / longest waiting) first
const holding = computed(() => byLane("holding").sort((a, b) => Number(isFlashing(b)) - Number(isFlashing(a))));

const label = (a: Aircraft) => a.title || projectName(a.project) || a.id;
const sub = (a: Aircraft) => [projectName(a.project), a.lastEventSummary].filter(Boolean).join(" · ");
const age = (a: Aircraft) => formatAge(a.stateSince ? props.now - a.stateSince : null);

// the overlay is meant to float transparently over other apps — clear the page background
// while mounted so only the strips paint (restored on unmount for normal browsing).
let prevHtml = "", prevBody = "";
// the native panel drives expand/collapse by cursor position (it can't rely on CSS :hover
// through a click-through window), toggling `.expanded`; :hover still works for the browser.
const setExpanded = (b: unknown) => document.querySelector(".ov-rail")?.classList.toggle("expanded", !!b);
onMounted(() => {
  prevHtml = document.documentElement.style.background;
  prevBody = document.body.style.background;
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  (window as any).__setOverlayExpanded = setExpanded;
});
onBeforeUnmount(() => {
  document.documentElement.style.background = prevHtml;
  document.body.style.background = prevBody;
  delete (window as any).__setOverlayExpanded;
});
</script>

<template>
  <div class="ov-rail">
    <TransitionGroup tag="div" class="ov-group" name="ov">
      <div v-for="(a, i) in inflight" :key="a.id" class="ov-item" :style="{ '--i': i, '--accent': LANE_COLOR.inflight }">
        <button class="ov-card" @click="emit('open', a.id)">
          <span class="ov-spine"></span>
          <span class="ov-body">
            <span class="ov-title">{{ label(a) }}</span>
            <span class="ov-sub">{{ sub(a) }}</span>
          </span>
        </button>
      </div>
    </TransitionGroup>

    <TransitionGroup tag="div" class="ov-group ov-holding" name="ov">
      <div v-for="(a, i) in holding" :key="a.id" class="ov-item" :class="{ flash: isFlashing(a) }" :style="{ '--i': i, '--accent': LANE_COLOR.holding }">
        <button class="ov-card" @click="emit('open', a.id)">
          <span class="ov-spine"></span>
          <span class="ov-body">
            <span class="ov-title">{{ label(a) }}</span>
            <span class="ov-sub">{{ age(a) }} · {{ sub(a) }}</span>
          </span>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
/* card geometry — collapsed shows only COLLAPSED px (the spine) at the screen's right edge */
.ov-rail { --w: 280px; --collapsed: 8px; position: fixed; top: 0; right: 0; height: 100vh; width: var(--w); display: flex; flex-direction: column; align-items: stretch; gap: 18px; padding: 14px 0; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; }
.ov-group { display: flex; flex-direction: column; gap: 7px; }
/* Holding sits directly below the in-flight block (the rail's gap separates them) */

.ov-item { position: relative; }
.ov-card {
  all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: stretch; gap: 0; cursor: pointer;
  background: color-mix(in srgb, var(--panel, #0d1117) 82%, transparent);
  border: 0.5px solid var(--border, #232a33); border-right: none;
  border-radius: 10px 0 0 10px; overflow: hidden; backdrop-filter: blur(8px);
  box-shadow: -6px 4px 18px rgba(0, 0, 0, 0.4);
  /* collapsed: pushed right so only the spine peeks. hover flies it in (see .ov-rail:hover) */
  transform: translateX(calc(100% - var(--collapsed)));
  transition: transform 0.42s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.3s ease, box-shadow 0.25s ease;
  transition-delay: calc(var(--i) * 28ms);
}
.ov-spine { flex: none; width: 5px; align-self: stretch; background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent); }
.ov-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px 12px 8px 10px; }
.ov-title { font-size: 12.5px; font-weight: 600; color: var(--text-hi, #e6edf3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-sub { font-size: 10.5px; color: var(--text-dim, #8b98a8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* fly-in on rail hover (browser) or when the native panel sets .expanded; stagger to cascade */
.ov-rail:hover .ov-card,
.ov-rail.expanded .ov-card { transform: translateX(0); }
/* focus: the hovered strip lifts + brightens, the others recede */
.ov-rail:hover .ov-item:not(:hover) .ov-card,
.ov-rail.expanded .ov-item:not(:hover) .ov-card { opacity: 0.55; }
.ov-card:hover { transform: translateX(0) scale(1.035) !important; opacity: 1 !important; box-shadow: -10px 6px 26px rgba(0, 0, 0, 0.55); }

/* a holding strip that needs you pulses its spine for attention */
.ov-item.flash .ov-spine { animation: ov-pulse 1.1s ease-in-out infinite; }
@keyframes ov-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* state changes: strips slide in / out from the right and FLIP to new positions */
.ov-move { transition: transform 0.45s cubic-bezier(0.2, 0.85, 0.25, 1); }
.ov-enter-active { transition: transform 0.45s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.35s ease; }
.ov-leave-active { transition: transform 0.4s ease, opacity 0.3s ease; position: absolute; width: 100%; }
.ov-enter-from, .ov-leave-to { opacity: 0; transform: translateX(110%); }

@media (prefers-reduced-motion: reduce) {
  .ov-card, .ov-move, .ov-enter-active, .ov-leave-active, .ov-item.flash .ov-spine { transition: none !important; animation: none !important; }
}
</style>
