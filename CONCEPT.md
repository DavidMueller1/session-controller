# Traffic Controller — Concept

A local web app that tracks the features you are implementing in parallel, styled after an
air traffic controller's **flight progress strips** — the little bricks a controller keeps
on the board, one per aircraft, so no plane is ever forgotten.

Here, each **feature-in-flight** is an aircraft, and each **Claude session** working on it
is tracked automatically — whether that session runs in the **PHPStorm terminal (Claude Code
CLI)** or in the **Claude Desktop app (Cowork / local agent mode)**.

---

## 1. The metaphor

| Air traffic control | Traffic Controller app |
|---|---|
| Aircraft | A feature you are building |
| Flight progress strip (the "brick") | A card holding everything about that feature |
| Callsign | Feature name / branch / ticket (e.g. `KLS-1234`) |
| Airspace sectors / lanes | Status columns: *Parked → Taxiing → In-flight → Holding → Approach → Landed* |
| Radar / transponder ping | Live signal from a Claude session (file activity, hooks) |
| Go-around | Sending a landed feature back up for a follow-up PR |
| Controller | You — you have the final word on every landing |

The point of a flight strip is **persistent, glanceable state** for many things at once.
That is exactly the problem with running several Claude sessions in parallel: it's easy to
lose track of which one is working, which one is blocked waiting for your input, and which one
the system *thinks* is done but you haven't actually reviewed yet.

---

## 2. Core question: can it auto-track both session types?

**Yes.** Both Claude Code surfaces persist their session state to the local filesystem, and
those files update live as the session runs. The app watches those files — no cooperation or
API from the apps themselves is required. Confirmed on this machine:

### 2a. PHPStorm terminal — Claude Code CLI
- **Transcripts:** `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
  - `<encoded-cwd>` is the working directory with `/` → `-` (e.g.
    `-Users-david-mueller-PhpstormProjects-feat-traffic-controller`). This gives us the
    **project a session belongs to, for free.**
  - The JSONL grows one line per event: `user`, `assistant`, `tool_use`, `tool_result`,
    `thinking`, `text`, etc. The **last line + its timestamp** tells us what the session is
    doing right now.
- **Per-session env:** `~/.claude/session-env/<session-id>/`
- **Hooks** (`~/.claude/settings.json`): `SessionStart`, `UserPromptSubmit`, `Stop`,
  `Notification`, `SessionEnd`. **We will install these** (decision §9) so the two
  hardest-to-infer states — *Holding (needs you)* and *session wrapped up* — are exact and
  instant instead of guessed. You already run a `Notification` hook, so this fits your setup.

### 2b. Claude Desktop app — Cowork / local agent mode
- **Session metadata:** `~/Library/Application Support/Claude/local-agent-mode-sessions/<org>/<workspace>/local_*.json`
  and `~/Library/Application Support/Claude/claude-code-sessions/<org>/<workspace>/local_*.json`.
- Each file already contains the fields we need:
  ```json
  {
    "sessionId": "local_492c7e31-…",
    "cliSessionId": "b12e2467-…",
    "cwd": "…/outputs",
    "createdAt": 1784184012689,
    "lastActivityAt": 1784184140605,
    "model": "claude-fable-5",
    "title": "Weekly presenter rotation",
    "isArchived": false,
    "hostLoopMode": true
  }
  ```
  - `lastActivityAt` → freshness / "is it still flying".
  - `title` → auto-generated strip label suggestion.
  - `isArchived` → session closed by the app.
  - `cliSessionId` → **links a desktop session to its underlying CLI transcript**, so both
    surfaces can be correlated into one aircraft when they're the same work.

### What this means
- **Tracking = watching two directory trees** for new/changed files, parsing the tail, and
  deriving status. Passive and safe — the app only ever reads Claude's files, never writes to
  them.
- Desktop sessions are tracked by **file-watching only** (poll `lastActivityAt` + tail
  transcript); the desktop app doesn't reliably fire `~/.claude` hooks. CLI sessions get both
  file-watching **and** hooks.

### Honest limitations
- Status is **inferred** from transcript shape (see §5). Installing the CLI hooks upgrades the
  *Holding* and *wrapped-up* signals from "inferred" to "known" on the terminal side.
- These are **undocumented internal file layouts.** A Claude Code/Desktop update could change
  them. The watcher must be defensive: tolerate schema drift, never crash on an unknown line.
- All local, single-user. No multi-machine sync in v1.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Sources (read-only)                                             │
│                                                                  │
│  ~/.claude/projects/**/*.jsonl        (CLI transcripts)          │
│  ~/.claude/session-env/**             (CLI session env)          │
│  ~/Library/Application Support/Claude/                           │
│      local-agent-mode-sessions/**     (Desktop sessions)         │
│      claude-code-sessions/**          (Desktop sessions)         │
│  CLI hooks           ──POST──▶ /ingest/hook   (Stop/Notif/End)   │
│  GitHub (via `gh`)   ──poll──▶ PR state per branch               │
└───────────────┬──────────────────────────────────────────────────┘
                │ fs.watch + debounced reconcile + gh poll
        ┌───────▼─────────┐
        │  Watcher/Daemon  │  parse tail, derive activity, poll PRs
        │  (Node + TS)     │  compute suggestions (branch / folder)
        └───────┬─────────┘
                │ writes
        ┌───────▼─────────┐        ┌──────────────────────┐
        │  SQLite store    │◀──────▶│  Backend / API + WS   │
        │  (better-sqlite3)│        │  (serves UI + events) │
        └─────────────────┘        └───────────┬───────────┘
                                                │ WebSocket (live)
                                        ┌───────▼─────────┐
                                        │  Vue web UI      │
                                        │  the flight strips│
                                        └──────────────────┘
```

- **Watcher/daemon:** the only component that touches Claude's files. `fs.watch` for liveness
  plus a periodic reconcile scan (catch missed events). Parses each transcript's tail
  incrementally (remembers byte offset per file). Also polls `gh` for PR state per branch.
- **Store:** **SQLite** (`better-sqlite3`) — cheap queries, history, survives restarts.
- **Backend + WebSocket:** serves the UI and pushes live status deltas so the board updates
  without refresh.
- **UI:** Vue SPA — the flight-strip board.

Daemon + backend run as one Node process for v1; optionally a launchd agent for background.

---

## 4. Data model

### Aircraft (feature card / flight strip) — the user-owned entity
```
id
callsign          // short label, e.g. "KLS-1234 upload flow"
description
project           // repo / folder
branch            // git branch
jiraTicket        // e.g. KLS-1234 (link)
priority
notes             // free text — the "brick" you scribble on
flightStatus      // Parked | In-flight | Holding | Approach | Landed  (see §5; you own this)
prState           // none | draft | open | review | merged | closed  (auto, from gh)
prUrl / prNumber
pinned            // keep on board even after landing
createdAt / updatedAt
```

### Session (auto-discovered, *suggested* onto an aircraft — you confirm)
```
id                // sessionId
source            // "cli" | "desktop"
transcriptPath
project / cwd
title             // auto title if available
model
firstSeenAt
lastActivityAt
activityState     // working | idle | dormant | needs-input | suspected-done | error
lastEventSummary  // e.g. "running tool: Bash" / "awaiting confirmation"
linkedCliSessionId
aircraftId        // set only when YOU assign it (nullable)
suggestedAircraft // computed guesses, ranked — never auto-applied
```

**Assignment is manual, with smart suggestions.** On discovery a session is *not* silently
attached. The daemon computes ranked suggestions from **git branch** and **project folder**
(and `cliSessionId` correlation), and the session sits in an **inbound tray** with those
suggestions surfaced. You pick — or create a new card in one click, or dismiss. You always
have the last word (decision §9).

---

## 5. Status model — two layers

Landing is **never** decided by a timer. Overnight gaps must not mark work as finished.
So we separate what the *system observes* from what *you decide*.

### Layer A — Session activity (automatic, never terminal)
Derived per session. This layer never declares a feature "done" on its own.

| activityState | How it's detected |
|---|---|
| **working** | Transcript growing; last event `assistant`/`tool_use`/`thinking`; recent `lastActivityAt`. |
| **needs-input** | CLI `Notification`/`Stop` hook fired, or assistant turn ended on a question with no new `user` line. Amber. |
| **idle** | No file change for a short while; session still open. |
| **dormant** | No activity for a long stretch (e.g. overnight). **Greyed, not landed** — just "cold". |
| **suspected-done** | A *soft* signal: `Stop`/`SessionEnd` hook fired, or desktop `isArchived: true`, or dormant + a merged PR. Shown as a "🛬 system thinks this is finished — confirm?" badge. **Never moves the aircraft to Landed by itself.** |
| **error** | *(removed)* tool errors are not terminal — Claude retries; no auto go-around. |

**Authoritative override (implemented).** For a **live CLI session**, Claude Code's own
`status` in `~/.claude/sessions/<pid>.json` overrides the inferred state: `busy` → working,
`idle` → needs-input (waiting on you). This is exact and needs no setup. The transcript-shape
inference above is the fallback for desktop-run sessions and ended sessions. `AskUserQuestion`
/ `ExitPlanMode` in the transcript also map straight to needs-input.

### Layer B — Flight status (the board lane — you own it, PR-informed)
| flightStatus | Meaning |
|---|---|
| **Parked** | Card created, no active work yet. |
| **In-flight** | Actively being worked (any session `working`). |
| **Holding** | A session `needs-input` — floats to top, amber. The "don't forget me" state. |
| **Approach** | System `suspected-done` and/or a PR is open/in review — *awaiting your review*. |
| **Landed** | **Only you set this.** Typically once the PR is merged and you're satisfied. |

### PR lifecycle (automatic overlay, via `gh`)
Each aircraft's branch is matched to its GitHub PR and shown with **little git icons** on the
strip: `no PR` · `draft` · `open` · `review requested` · **merged** ✓ · `closed`. A **merged
PR** is the strongest hint to move to *Approach → Landed*, but the move stays your call.

### Go-around (follow-up PRs)
A **Landed** aircraft isn't gone. Selecting **Go-around** sends it back into the pattern for a
follow-up PR: it keeps its history, resets `prState` for the new branch/PR, and returns to
*In-flight*. This models "the feature shipped, now I'm adding more in a follow-up PR."

---

## 6. UI concept — the board

- **Columns = airspace sectors** (the flight-status lanes). Strips advance left→right.
  Activity moves them automatically up to *Approach*; **Landed is a deliberate action you
  take**, and *Go-around* sends them back.
- **A flight strip (brick)** shows at a glance:
  - Callsign + project/branch + Jira ticket
  - Source badge: `TERM` (PHPStorm) vs `DESKTOP`
  - Live activity dot (working = pulsing, needs-input = amber, dormant = grey)
  - **Git/PR icon** reflecting PR state (draft/open/review/merged)
  - "Last ping" relative time + one-line current activity
  - A **"🛬 suspected done — confirm landing?"** prompt when Layer A says so
  - Your notes
- **Inbound tray with assignment UI:** newly discovered sessions land here with **ranked
  suggestions** (branch match, folder match). One click assigns to a card, spins up a new
  card, or dismisses. This is the "I want the last word" flow.
- **Holding highlight:** any aircraft `needs-input` floats to the top / flashes amber.
- **Landed / archive:** finished flights collapse aside but stay searchable and go-around-able.

---

## 7. Stack (decided)

- **Backend/daemon:** Node.js + TypeScript — `chokidar` (watch), `better-sqlite3` (store),
  `fastify` + `ws` (API + WebSocket), `gh` CLI shelled out for PR state.
- **Frontend:** **Vue 3** (Vite) SPA. Real-time via WebSocket.
- **Packaging:** local dev server opened in the browser; optional launchd agent so the watcher
  runs in the background.
- Single-user, localhost-only. No auth in v1.

---

## 8. Non-goals (v1)

- No writing to or controlling Claude sessions (read-only observer).
- No cloud sync / multi-machine.
- No reading transcript *content* beyond event types + timestamps needed for status (we don't
  need message bodies).
- No automatic landing on a timer — landing is always your explicit action.

---

## 9. Decisions (locked)

1. **Store:** ✅ SQLite (`better-sqlite3`).
2. **CLI hooks:** ✅ Install `Stop`/`Notification`/`SessionEnd` hooks for precise
   *needs-input* / *suspected-done* detection.
3. **Frontend:** ✅ Vue 3.
4. **Naming instead of assignment:** ✅ **Superseded.** The original plan was a manual
   session→card assignment tray. In practice each CLI session already carries a user-set
   **name** (the `/rename` value, stored in `~/.claude/sessions/<pid>.json` and read live),
   and desktop sessions carry their own title. That name *is* the callsign, so the app is a
   **session tracker** — no separate card/assignment layer. Annotation is covered by notes +
   landed. (Phase 4 dropped.)
5. **Card metadata:** notes + landed on each session strip (rich cards/Jira dropped with the
   assignment layer; revisit only if a real need appears).
6. **Landing:** ✅ **No time-based auto-landing.** Two-layer model (§5): the system shows a
   *suspected-done* signal and live PR state (git icons: exists / merged), but **only you mark
   a feature Landed**. Dormant ≠ landed (overnight-safe). **Go-around** supported for
   follow-up PRs.

7. **No hooks (for shareability):** ✅ For distributing to colleagues, file-watching + the
   registry `status` field is the right base: **zero per-machine setup**, covers CLI + desktop
   + history, and recovers state on restart. Hooks would require editing each person's
   `settings.json`, only fire for CLI sessions (not desktop), and drop events when the app
   isn't running — so they'd be an optional power-user add-on at best, not the baseline.

### Still to confirm (minor)
- **PR poll interval** (e.g. every 60s vs. on-demand refresh) and which repos/remotes to scan.
- **Dormant threshold** for the grey "cold" indicator only (purely visual, never terminal) —
  suggest ~2h.
- **Cross-platform**: core watching is portable; desktop paths + the `open` window-focus are
  macOS-only and need per-OS handling before non-mac colleagues can use those parts.

---

## 10. Build phases

1. ✅ **Watcher spike** — read both source trees, derive activity state, dedupe. Console board.
2. ✅ **Store + API** — SQLite + Fastify REST/WebSocket over a shared engine.
3. ✅ **Board UI (Vue)** — dark control-tower board: in-flight band, lanes, flashing holding,
   notes → parked, FLIP animation, manual Landed row + go-around, MIA (soft in-flight) state.
4. ~~Inbound tray + assignment~~ — **dropped** (see §9.4). Replaced by live session naming:
   CLI strips use the `/rename` value from `~/.claude/sessions`; desktop strips use their title.
5. ✅ **Registry status** — for live CLI sessions, take state from Claude Code's own
   `~/.claude/sessions` `status` (busy → In-flight, idle → Holding); authoritative, no
   transcript guesswork, **zero per-machine setup**. Desktop sessions fall back to inference.
   Also: `open` action focuses the host window; AskUserQuestion/ExitPlanMode → Holding; tool
   errors are not terminal. **Hooks intentionally skipped** — they'd need per-machine
   settings.json edits and only cover CLI (see the distribution note in §9).
6. **PR integration** — `gh` polling, git icons, Approach lane, Landed-on-merge nudge.
7. **Polish + packaging** — holding alerts, archive/search, launchd agent; cross-platform
   desktop paths + a simple install so colleagues can run it.
