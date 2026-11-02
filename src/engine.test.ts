import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG } from "./config.js";
import { Engine } from "./engine.js";

/** a desktop session root as Claude lays it out: <org>/<user>/local_<id>.json + <session>/.claude/projects */
function desktopRoot(): { root: string; session: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-desktop-"));
  const user = path.join(root, "org", "user");
  const session = path.join(user, "local_a");
  fs.mkdirSync(path.join(session, ".claude", "projects", "-p"), { recursive: true });
  fs.mkdirSync(path.join(session, "outputs", "deep", "tree"), { recursive: true });
  fs.writeFileSync(path.join(user, "local_a.json"), "{}");
  fs.writeFileSync(path.join(session, ".claude", "projects", "-p", "s1.jsonl"), "");
  return { root, session };
}

test("flags a desktop layout change only once Claude puts sessions somewhere the layout walk doesn't look", async () => {
  const { root, session } = desktopRoot();
  const saved = CONFIG.desktopSessionDirs;
  CONFIG.desktopSessionDirs = [root];
  try {
    const engine = new Engine();
    const verify = () => (engine as unknown as { verifyDesktopLayout(): Promise<void> }).verifyDesktopLayout();
    await verify();
    assert.equal(engine.desktopLayoutChanged(), false);

    fs.mkdirSync(path.join(session, "transcripts"), { recursive: true });
    fs.writeFileSync(path.join(session, "transcripts", "s2.jsonl"), "");
    await verify();
    assert.equal(engine.desktopLayoutChanged(), true);
  } finally {
    CONFIG.desktopSessionDirs = saved;
  }
});
