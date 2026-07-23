<script setup lang="ts">
import { computed, ref, nextTick } from "vue";
import type { Aircraft } from "../types";
import { STATE, isParked, isFlashing, formatAge, projectName } from "../format";

const props = defineProps<{ aircraft: Aircraft; now: number }>();
const emit = defineEmits<{ setNote: [id: string, note: string]; removeNote: [id: string] }>();

const meta = computed(() => STATE[props.aircraft.state]);
const parked = computed(() => isParked(props.aircraft));
const flashing = computed(() => isFlashing(props.aircraft));
const age = computed(() => formatAge(props.aircraft.lastActivityAt ? props.now - props.aircraft.lastActivityAt : null));
const surfaces = computed(() => props.aircraft.surfaces ?? [props.aircraft.source]);
const badge = computed(() => (parked.value ? "Parked" : meta.value.label));

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
  <div
    class="strip"
    :class="{ flash: flashing, parked }"
    :data-fid="aircraft.id"
    :style="{ background: parked ? 'var(--strip-parked)' : undefined }"
  >
    <div class="spine" :style="{ background: parked ? 'var(--amber-deep)' : meta.color }"></div>
    <div class="body">
      <div class="cs">
        <span class="title">{{ aircraft.title || aircraft.id }}</span>
        <span
          v-if="aircraft.state === 'needs-input' || aircraft.state === 'error' || parked"
          class="badge"
          :style="parked
            ? { background: 'var(--amber-bg)', color: 'var(--amber)' }
            : { background: meta.color, color: 'var(--bg)' }"
        >{{ badge }}</span>
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
        <span class="age" :style="{ color: meta.color }">{{ age }}</span>
      </div>

      <div class="notes">
        <span v-if="aircraft.note && !editing" class="note">
          <i class="ti ti-pin"></i>
          <span>{{ aircraft.note }}</span>
          <button class="note-x" aria-label="remove note" @click="emit('removeNote', aircraft.id)"><i class="ti ti-x"></i></button>
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
        <button v-if="!aircraft.note && !editing" class="add" @click="openNote"><i class="ti ti-plus"></i> note</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.strip { display: flex; background: var(--strip); border: 0.5px solid var(--border); border-radius: 8px; overflow: hidden; animation: strip-in 0.3s ease; }
.spine { width: 4px; flex: none; }
.body { flex: 1; min-width: 0; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cs { display: flex; align-items: center; gap: 6px; }
.title { font-size: 13px; font-weight: 500; color: var(--text-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; flex: none; }
.chips { display: flex; gap: 5px; flex-wrap: wrap; }
.chip { font-size: 11px; color: var(--text-dim); background: var(--chip); border-radius: 6px; padding: 1px 6px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.act { font-size: 11px; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.foot { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-faint); }
.foot .age { margin-left: auto; font-weight: 500; }
.notes { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.note { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; background: var(--amber-bg); color: var(--amber); border-radius: 6px; padding: 2px 4px 2px 7px; }
.note-x { all: unset; cursor: pointer; display: inline-flex; }
.note-input { font-size: 11px; height: 26px; width: 100%; }
.add { font-size: 11px; color: var(--text-faint); border: 0.5px dashed var(--border); border-radius: 6px; padding: 1px 7px; background: transparent; }
.add:hover { color: var(--text-dim); border-color: var(--gray); }
</style>
