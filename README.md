<div align="center">
  <img src="web/public/logo.svg" width="84" alt="Session Controller logo" />
  <h1>Session Controller</h1>
  <p><strong>A dashboard for running multiple Claude Code sessions in parallel without getting overwhelmed.</strong></p>
  <p>See every session at a glance, know which one is waiting on you, and jump straight back into it.</p>
  <p>
    <img alt="macOS" src="https://img.shields.io/badge/macOS-06090d?style=for-the-badge&logo=apple&logoColor=white" />
    <img alt="self-updating" src="https://img.shields.io/badge/self--updating-3fb950?style=for-the-badge&labelColor=0d1117&color=3fb950" />
    <img alt="read-only" src="https://img.shields.io/badge/read--only-7d8590?style=for-the-badge&labelColor=0d1117&color=7d8590" />
  </p>
</div>

<p align="center">
  <img src="docs/screenshots/board.png" alt="Session Controller dashboard showing multiple Claude Code sessions as flight strips across the In-flight, Holding, Parked, MIA and Landed lanes" />
</p>

Every Claude Code session, in a terminal or the Claude desktop app, shows up on its own as a live
**flight strip** that moves between lanes as its state changes. It runs locally as a macOS menu-bar
app and never writes to Claude's files.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/DavidMueller1/session-controller/main/install.sh | bash
```

This builds the menu-bar app on your Mac, wires the tracking hooks, and adds a Login Item. The
dashboard runs at <http://127.0.0.1:4317>. You need macOS and [Claude Code](https://code.claude.com);
the [GitHub CLI](https://cli.github.com) is optional, for PR pills.

## Features

- **Live status** for every session, driven by Claude Code hooks
- **Knows who needs you:** strips flash when a session is waiting on your answer, with optional notifications
- **One click back in:** focuses the exact iTerm2 or Terminal.app tab, JetBrains window, or Claude app,
  and reopens a closed terminal session with `claude --resume`
- **Search** by title, branch, or folder (press `/`)
- **Plan usage:** how much of your Claude plan's weekly limit is used, plus any extra credits
- **API cost:** what today's and this month's tokens cost at API list prices
- **Per strip:** PR status, dev server controls, context usage, and token cost

<p align="center">
  <img src="docs/screenshots/taxi.gif" width="720" alt="A Claude Code session strip taxiing between lanes as its state changes from working to waiting for input" />
</p>

## The board

| Lane | Meaning |
|---|---|
| ![In-flight](https://img.shields.io/badge/In--flight-3fb950?style=flat-square&labelColor=3fb950&color=3fb950) | working now |
| ![Holding](https://img.shields.io/badge/Holding-e0a92e?style=flat-square&labelColor=e0a92e&color=e0a92e) | waiting on you (flashes) |
| ![Parked](https://img.shields.io/badge/Parked-e0823c?style=flat-square&labelColor=e0823c&color=e0823c) | waiting on you, set aside with a note |
| ![MIA](https://img.shields.io/badge/MIA-7d8590?style=flat-square&labelColor=7d8590&color=7d8590) | quiet for 5+ minutes, or wrapped up |
| ![Landed](https://img.shields.io/badge/Landed-4cc38a?style=flat-square&labelColor=4cc38a&color=4cc38a) | you marked it done |

<table>
  <tr>
    <td><img src="docs/screenshots/detail.png" alt="Detail view of a Claude Code session with project, branch, model, context usage, cost, pull request and timeline" /></td>
    <td><img src="docs/screenshots/grid.png" alt="Grid view listing every Claude Code session in the In-flight lane" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Click a strip for its details</sub></td>
    <td align="center"><sub>Click a lane's name for the grid</sub></td>
  </tr>
</table>

## FAQ

**Does it send my code or conversations anywhere?**
No. It reads Claude's local session files and runs entirely on your Mac, with no account and no
telemetry. Its only network calls are the Claude status page, `gh` for PR pills, and updates from
this repo.

**How does it stay up to date?**
It installs updates when it launches. While it's running, a banner offers **Update now** when a
new version is out. Your board (notes, landings) is never touched by an update.

**Strips stopped updating?**
A Claude update may have removed the tracking hooks. The board shows a banner when that happens;
run `pnpm run doctor` in the repo to re-wire them.

**What do PLAN and API in the header show?**
PLAN is your Claude plan's weekly limit (as in `/usage`) and the extra credits you've used past it.
API is what your tokens would cost at API list prices. On a plan that isn't what you pay; without a
plan it is, and PLAN shows a NO PLAN sticker. Either can be hidden in Settings.

## Develop

```bash
nvm use            # Node 22
pnpm run setup     # deps, UI build, hooks
pnpm dev:live      # dev UI with hot reload, using the installed app's data
pnpm typecheck
pnpm screenshots   # regenerate docs/screenshots from demo mode (fake data)
```

Add `?demo` to the dashboard URL for made-up sessions (`?demo=tour` animates a few lane changes).
[CONCEPT.md](CONCEPT.md) has the full design.

---

<p align="center">
  <sub>If Session Controller saves you some tab-hunting:</sub><br />
  <a href="https://buymeacoffee.com/davidsaysthankyou"><img alt="Buy me a coffee" src="https://img.shields.io/badge/Buy_me_a_coffee-davidsaysthankyou-FFDD00?style=for-the-badge&logo=buymeacoffee&logoColor=0d1117&labelColor=FFDD00" /></a>
</p>
