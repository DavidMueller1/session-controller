<script setup lang="ts">
import { computed, ref, nextTick } from "vue";
import type { Aircraft } from "../types";
import { STATE, LANDED_COLOR, isParked, isFlashing, formatAge, projectName } from "../format";

const props = defineProps<{ aircraft: Aircraft; now: number }>();
const emit = defineEmits<{
  setNote: [id: string, note: string];
  removeNote: [id: string];
  land: [id: string];
  unland: [id: string];
}>();

const meta = computed(() => STATE[props.aircraft.state]);
const landed = computed(() => !!props.aircraft.landed);
const parked = computed(() => isParked(props.aircraft) && !landed.value);
const flashing = computed(() => isFlashing(props.aircraft) && !landed.value);
const age = computed(() => formatAge(props.aircraft.lastActivityAt ? props.now - props.aircraft.lastActivityAt : null));
const surfaces = computed(() => props.aircraft.surfaces ?? [props.aircraft.source]);
const spineColor = computed(() => (landed.value ? LANDED_COLOR : parked.value ? "var(--amber-deep)" : meta.value.color));

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
  <div class="strip" :class="{ flash: flashing, parked, landed }" :data-fid="aircraft.id">
    <div class="spine" :style="{ background: spineColor }"></div>
    <div class="body">
      <div class="cs">
        <span class="title">{{ aircraft.title || aircraft.id }}</span>
        <span v-if="landed" class="badge" style="background: #16301f; color: #4cc38a"><i class="ti ti-check"></i> Landed</span>
        <span v-else-if="parked" class="badge" style="background: var(--amber-bg); color: var(--amber)">Parked</span>
        <span
          v-else-if="aircraft.state === 'needs-input' || aircraft.state === 'error'"
          class="badge"
          :style="{ background: meta.color, color: 'var(--bg)' }"
        >{{ meta.label }}</span>
      </div>

      <div class="chips">
        <span class="chip mono">{{ projectName(aircraft.project) }}</span>
        <span v-if="aircraft.branch" class="chip mono"><i class="ti ti-git-branch"></i> {{ aircraft.branch }}</span>
        <span v-if="aircraft.model" class="chip mono">{{ aircraft.model }}</span>
      </div>

      <div class="act">{{ aircraft.lastEventSummary }}</div>

      <div class="foot">
        <i v-if="surfaces.includes('cli')" class="ti ti-terminal-2" title="terminal"></i>
        <i v-if="surfaces.includes('desktop')" class="ti ti-device-desktop" title="desktop"></i>
        <span class="age" :style="{ color: landed ? LANDED_COLOR : meta.color }">{{ age }}</span>
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

        <button v-if="!landed" class="ghost land" title="Mark landed" @click="emit('land', aircraft.id)">
          <i class="ti ti-plane-arrival"></i> land
        </button>
        <button v-else class="ghost" title="Send back into the pattern" @click="emit('unland', aircraft.id)">
          <i class="ti ti-plane-departure"></i> go-around
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
.spine { width: 4px; flex: none; }
.body { flex: 1; min-width: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cs { display: flex; align-items: center; gap: 6px; }
.title { font-size: 13px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; flex: none; display: inline-flex; align-items: center; gap: 3px; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; color: var(--text-dim); background: var(--chip); border-radius: 6px; padding: 1px 6px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); }
.foot .age { margin-left: auto; font-weight: 500; }
.actions { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.note { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; background: var(--amber-bg); color: var(--amber); border-radius: 6px; padding: 2px 4px 2px 7px; }
.icon { all: unset; cursor: pointer; display: inline-flex; }
.note-input { font-size: 11px; height: 26px; width: 100%; }
.ghost { font-size: 11px; color: var(--text-faint); border: 0.5px dashed var(--border); border-radius: 6px; padding: 1px 7px; background: transparent; display: inline-flex; align-items: center; gap: 4px; }
.ghost:hover { color: var(--text-dim); border-color: var(--gray); }
.ghost.land:hover { color: #4cc38a; border-color: #2f6f4f; }
@media (prefers-reduced-motion: reduce) {
  .strip.flash { animation: none; background: var(--amber-bg); }
}
</style>
