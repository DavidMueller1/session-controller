<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, nextTick, watch, ref } from "vue";
import { laneOf, isFlashing, projectName, formatAge } from "../format";
import type { Aircraft } from "../types";

// Right-edge rail overlay: normally only the colour-coded spine of each strip peeks at the
// screen edge; hovering ANY spine flies the WHOLE rail in (in-flight on top, holding below) so
// you can read every strip at once. A pin keeps it open after the cursor leaves. Lives in a
// transparent always-on-top panel that's click-through except over the strips / the pin.
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

// The native panel is non-activating, so the web view never gets mouseMoved → CSS :hover
// can't fire there. Instead Swift polls the cursor and drives the reveal: we report each strip's
// vertical rect (and the pin's rect), and Swift calls __overlayReveal(true/false) for the whole
// rail. In the browser preview (no bridge) plain :hover handles it. `pinned` keeps it revealed.
const revealed = ref(false); // Swift-driven (native); browser uses :hover
const pinned = ref(false);
const showAll = computed(() => revealed.value || pinned.value);
const isNative = typeof (window as unknown as { webkit?: { messageHandlers?: { overlay?: unknown } } }).webkit?.messageHandlers?.overlay !== "undefined";

const pinEl = ref<HTMLButtonElement | null>(null);

function reportState() {
  const bridge = (window as any).webkit?.messageHandlers?.overlay;
  if (!bridge) return;
  const strips = [...document.querySelectorAll<HTMLElement>(".ov-item")].map((el) => {
    const r = el.getBoundingClientRect();
    return { id: el.dataset.id, top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
  // pin sits in a fixed layout slot (only its opacity animates), so its rect is stable and can
  // be reported anytime — Swift only hit-tests it while the rail is revealed.
  let pin: { top: number; bottom: number; left: number; right: number } | null = null;
  if (pinEl.value) {
    const r = pinEl.value.getBoundingClientRect();
    pin = { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
  }
  bridge.postMessage({ strips, pin, pinned: pinned.value });
}
const onResize = () => reportState();

function togglePin() {
  pinned.value = !pinned.value;
  reportState(); // let Swift keep the rail open (or release it) immediately
}

watch(() => props.aircraft, () => nextTick(reportState), { deep: false });
watch(pinned, () => nextTick(reportState));

onMounted(() => {
  prevHtml = document.documentElement.style.background;
  prevBody = document.body.style.background;
  document.documentElement.style.background = "transparent";
  document.body.style.background = "transparent";
  window.addEventListener("resize", onResize);
  (window as any).__overlayReveal = (v: boolean) => { revealed.value = !!v; };
  nextTick(reportState);
});
onBeforeUnmount(() => {
  document.documentElement.style.background = prevHtml;
  document.body.style.background = prevBody;
  window.removeEventListener("resize", onResize);
  delete (window as any).__overlayReveal;
  (window as any).webkit?.messageHandlers?.overlay?.postMessage({ strips: [], pin: null, pinned: false });
});
</script>

<template>
  <div class="ov-rail" :class="{ native: isNative, reveal: showAll }">
    <button ref="pinEl" class="ov-pin" :class="{ on: pinned }" :title="pinned ? 'Unpin — collapse when the cursor leaves' : 'Pin — keep the rail open'" aria-label="Pin overlay" @click="togglePin">
      <i class="ti ti-pin"></i>
    </button>

    <TransitionGroup tag="div" class="ov-group" name="ov">
      <div v-for="a in inflight" :key="a.id" class="ov-item" :data-id="a.id" :style="{ '--accent': LANE_COLOR.inflight }">
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
      <div v-for="a in holding" :key="a.id" class="ov-item" :data-id="a.id" :class="{ flash: isFlashing(a) }" :style="{ '--accent': LANE_COLOR.holding }">
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
.ov-rail { --w: 280px; --collapsed: 8px; position: fixed; top: 0; right: 0; height: 100vh; width: var(--w); display: flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 18px; padding: 14px 0; font-family: ui-sans-serif, -apple-system, system-ui, sans-serif; }
.ov-group { display: flex; flex-direction: column; gap: 7px; }
/* Holding sits directly below the in-flight block (the rail's gap separates them) */

.ov-item { position: relative; }
.ov-card {
  all: unset; box-sizing: border-box; width: 100%; display: flex; align-items: stretch; gap: 0; cursor: pointer;
  background: color-mix(in srgb, var(--panel, #0d1117) 82%, transparent);
  border: 0.5px solid var(--border, #232a33); border-right: none;
  border-radius: 10px 0 0 10px; overflow: hidden; backdrop-filter: blur(8px);
  box-shadow: -6px 4px 18px rgba(0, 0, 0, 0.4);
  /* collapsed: pushed right so only the spine peeks. revealing the rail flies them all in */
  transform: translateX(calc(100% - var(--collapsed)));
  transition: transform 0.42s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.3s ease, box-shadow 0.25s ease;
}
.ov-spine { flex: none; width: 5px; align-self: stretch; background: var(--accent); box-shadow: 0 0 8px color-mix(in srgb, var(--accent) 60%, transparent); }
.ov-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; padding: 8px 12px 8px 10px; }
.ov-title { font-size: 12.5px; font-weight: 600; color: var(--text-hi, #e6edf3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ov-sub { font-size: 10.5px; color: var(--text-dim, #8b98a8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* revealed → EVERY card flies in (native uses the `.reveal` class set by Swift; the browser
   preview uses :hover). They go fully opaque and lift with a stronger shadow. */
.ov-rail.reveal .ov-card,
.ov-rail:not(.native):hover .ov-card { transform: translateX(0); background: var(--panel, #0d1117); box-shadow: -10px 6px 26px rgba(0, 0, 0, 0.55); }

/* pin: a small tab at the top-right. Only its opacity animates (its layout slot stays put, so
   the rect we report to Swift is stable). Amber when engaged. */
.ov-pin {
  all: unset; box-sizing: border-box; align-self: flex-end; cursor: pointer;
  width: 26px; height: 26px; display: flex; align-items: center; justify-content: center;
  color: var(--text-dim, #8b98a8); font-size: 14px;
  background: color-mix(in srgb, var(--panel, #0d1117) 82%, transparent);
  border: 0.5px solid var(--border, #232a33); border-right: none; border-radius: 8px 0 0 8px;
  backdrop-filter: blur(8px); box-shadow: -6px 4px 18px rgba(0, 0, 0, 0.4);
  opacity: 0; pointer-events: none; transition: opacity 0.3s ease, color 0.15s ease;
}
.ov-rail.reveal .ov-pin,
.ov-rail:not(.native):hover .ov-pin { opacity: 1; pointer-events: auto; }
.ov-pin:hover { color: var(--text-hi, #e6edf3); }
.ov-pin.on { color: var(--amber, #e0a92e); opacity: 1; pointer-events: auto; } /* pinned → always visible */

/* a holding strip that needs you pulses its spine for attention */
.ov-item.flash .ov-spine { animation: ov-pulse 1.1s ease-in-out infinite; }
@keyframes ov-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* state changes: strips slide in / out from the right and FLIP to new positions */
.ov-move { transition: transform 0.45s cubic-bezier(0.2, 0.85, 0.25, 1); }
.ov-enter-active { transition: transform 0.45s cubic-bezier(0.2, 0.85, 0.25, 1), opacity 0.35s ease; }
.ov-leave-active { transition: transform 0.4s ease, opacity 0.3s ease; position: absolute; width: 100%; }
.ov-enter-from, .ov-leave-to { opacity: 0; transform: translateX(110%); }

@media (prefers-reduced-motion: reduce) {
  .ov-card, .ov-pin, .ov-move, .ov-enter-active, .ov-leave-active, .ov-item.flash .ov-spine { transition: none !important; animation: none !important; }
}
</style>
