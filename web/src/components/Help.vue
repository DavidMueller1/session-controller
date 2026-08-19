<script setup lang="ts">
defineEmits<{ close: [] }>();

const lanes = [
  { name: "In-flight", color: "#3fb950", desc: "Actively working or thinking." },
  { name: "Holding", color: "#e0a92e", desc: "Finished a turn and waiting on you — the strip flashes for attention." },
  { name: "Parked", color: "#e0823c", desc: "A “needs you” strip you triaged by adding a note — set aside, calm." },
  { name: "MIA", color: "#7d8590", desc: "Lost contact: quiet 5+ min, wrapped up, or dormant. Still tracked — nothing vanishes." },
  { name: "Landed", color: "#4cc38a", desc: "You marked it done. Landings older than 7 days are hidden." },
];

// authentic replicas of the strip's state badges (a working/In-flight strip has no badge —
// it's shown by the green lane + spine)
const badges = [
  { label: "Needs you", bg: "#e0a92e", fg: "var(--bg)", desc: "Waiting for your answer — the strip flashes." },
  { label: "Parked", bg: "var(--parked-bg)", fg: "var(--parked)", icon: "ti-parking", desc: "Triaged with a note." },
  { label: "MIA", bg: "#1c222c", fg: "#8b98a8", icon: "ti-clock", desc: "No activity for 5+ min — still flying, just out of contact." },
  { label: "Wrapped up", bg: "#1c222c", fg: "#8b98a8", desc: "Looks finished / lost contact (also “Dormant”, “Unknown”)." },
  { label: "Landed", bg: "#16301f", fg: "#4cc38a", icon: "ti-check", desc: "Marked done by you." },
  { label: "Approach", bg: "rgba(88,166,255,0.14)", fg: "var(--blue)", icon: "ti-plane-inflight", desc: "Its PR is merged — cleared to land. Rides alongside the state badge." },
];

const actions = [
  { icon: "ti-pointer", title: "Click a strip", desc: "Opens its detail — full path, model, surfaces, last event, timestamps, and Open window." },
  { icon: "ti-server-2", title: "dev ▾", desc: "Install dependencies, start / stop the dev server, and view live logs." },
  { icon: "ti-pin", title: "note", desc: "Pin a note — turns a flashing “Needs you” into a calm Parked strip." },
  { icon: "ti-plane-arrival", title: "land", desc: "Mark done → Landed. Auto-un-lands if the session starts working again." },
  { icon: "ti-settings", title: "Settings (gear)", desc: "Per-repo & global dev config: start / install commands, open-URL, env vars." },
  { icon: "ti-plane", title: "Board toggle", desc: "Switch between the flight board and the simple per-lane list." },
  { icon: "ti-bell", title: "Bell", desc: "Desktop notification when a session needs you." },
];
</script>

<template>
  <Teleport to="body">
    <div class="h-overlay" @click.self="$emit('close')">
      <div class="h-panel">
        <div class="h-head">
          <span class="h-title"><i class="ti ti-help-circle"></i> Reading the board</span>
          <button class="icon" aria-label="close" @click="$emit('close')"><i class="ti ti-x"></i></button>
        </div>

        <div class="h-body">
          <p class="h-intro">
            Every Claude Code session is a <b>flight strip</b>. Strips move between <b>lanes</b> as their state
            changes — like an air-traffic-control board.
          </p>

          <div class="h-sec">Lanes</div>
          <div class="h-legend">
            <div v-for="l in lanes" :key="l.name" class="h-item">
              <span class="h-spine" :style="{ background: l.color }"></span>
              <div class="h-text"><b :style="{ color: l.color }">{{ l.name }}</b><span>{{ l.desc }}</span></div>
            </div>
          </div>

          <div class="h-sec">Status badges</div>
          <div class="h-legend">
            <div v-for="b in badges" :key="b.label" class="h-item">
              <span class="h-vis"><span class="hbadge" :style="{ background: b.bg, color: b.fg }"><i v-if="b.icon" class="ti" :class="b.icon"></i>{{ b.label }}</span></span>
              <div class="h-text"><span>{{ b.desc }}</span></div>
            </div>
          </div>

          <div class="h-sec">On each strip</div>
          <div class="h-legend">
            <div class="h-item">
              <span class="h-vis">
                <svg class="hctx" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7" fill="none" stroke="var(--border)" stroke-width="2.5" /><circle cx="9" cy="9" r="7" fill="none" stroke="var(--amber)" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="44" stroke-dashoffset="15" transform="rotate(-90 9 9)" /></svg>
              </span>
              <div class="h-text"><b>Context ring</b><span>Share of the context window used — amber past 75%, red past 90%.</span></div>
            </div>
            <div class="h-item">
              <span class="h-vis"><span class="hpr"><i class="ti ti-git-pull-request"></i>#42</span></span>
              <div class="h-text"><b>PR pill</b><span>The branch's GitHub PR, coloured by review state. Click to open it.</span></div>
            </div>
            <div class="h-item">
              <span class="h-vis"><span class="hdev"><span class="hdot"></span>:5173</span></span>
              <div class="h-text"><b>Dev-server pill</b><span>A dev server detected in the folder. Click to open it (or pick from several). Green dot = live.</span></div>
            </div>
          </div>

          <div class="h-sec">Buttons &amp; actions</div>
          <div class="h-legend">
            <div v-for="x in actions" :key="x.title" class="h-item">
              <span class="h-vis"><i class="ti h-ico" :class="x.icon"></i></span>
              <div class="h-text"><b>{{ x.title }}</b><span>{{ x.desc }}</span></div>
            </div>
          </div>

          <div class="h-sec">Top banners</div>
          <p class="h-note">
            A banner appears only when something needs attention: <b>Claude service status</b> (from status.claude.com),
            and a <b>tracking-health</b> warning if the live-state pipeline degrades.
          </p>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.h-overlay { position: fixed; inset: 0; z-index: 62; background: rgba(6, 9, 13, 0.66); display: flex; align-items: center; justify-content: center; padding: 32px; }
.h-panel { width: min(680px, 94vw); max-height: 84vh; display: flex; flex-direction: column; background: var(--panel); border: 0.5px solid var(--border); border-radius: 12px; box-shadow: 0 18px 60px rgba(0, 0, 0, 0.5); overflow: hidden; }
.h-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 13px 15px; border-bottom: 0.5px solid var(--border-soft); font-size: 13px; font-weight: 600; color: var(--text-hi); }
.h-title { display: inline-flex; align-items: center; gap: 7px; }
.h-head .icon { all: unset; cursor: pointer; display: inline-flex; padding: 4px; border-radius: 6px; color: var(--text-faint); font-size: 15px; }
.h-head .icon:hover { background: rgba(255, 255, 255, 0.08); color: var(--text-dim); }
.h-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 15px 16px; }
.h-intro { font-size: 12.5px; line-height: 1.55; color: var(--text-dim); margin: 12px 2px 4px; }
.h-note { font-size: 12px; line-height: 1.55; color: var(--text-dim); margin: 4px 2px 0; }
.h-sec { font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; color: var(--text-faint); margin: 20px 2px 8px; padding-bottom: 5px; border-bottom: 0.5px solid var(--border-soft); }
.h-legend { display: flex; flex-direction: column; gap: 2px; }
.h-item { display: grid; grid-template-columns: 96px 1fr; gap: 12px; align-items: center; padding: 6px 2px; border-radius: 7px; }
.h-item:hover { background: rgba(255, 255, 255, 0.02); }
.h-vis { display: inline-flex; align-items: center; min-height: 18px; }
.h-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: 12px; }
.h-text b { color: var(--text-hi); font-weight: 600; }
.h-text span { color: var(--text-dim); line-height: 1.45; }

.h-spine { width: 5px; height: 26px; border-radius: 3px; flex: none; }
.hbadge { font-size: 10px; padding: 1px 6px; border-radius: 6px; white-space: nowrap; display: inline-flex; align-items: center; gap: 3px; }
.hctx { width: 18px; height: 18px; }
.hpr { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; border: 0.5px solid var(--blue); color: var(--blue); border-radius: 6px; padding: 0 5px; }
.hdev { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-family: ui-monospace, Menlo, monospace; color: var(--green); border: 0.5px solid color-mix(in srgb, var(--green) 40%, transparent); border-radius: 6px; padding: 0 5px; }
.hdot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); box-shadow: 0 0 5px color-mix(in srgb, var(--green) 70%, transparent); }
.h-ico { font-size: 15px; color: var(--text-dim); }
</style>
