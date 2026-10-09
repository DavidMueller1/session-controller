import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverAccounts } from "./accounts.js";

test("finds a second login in ~/.claude-<name>, but not a backup copy of ~/.claude", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-privat", "projects"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude-privat", ".claude.json"), "{}");
  fs.mkdirSync(path.join(home, ".claude-backup", "projects"), { recursive: true });
  fs.mkdirSync(path.join(home, ".claude-empty"));
  fs.writeFileSync(path.join(home, ".claude.json"), "{}");
  assert.deepEqual(
    discoverAccounts(home).map((a) => a.id),
    ["default", "privat"],
  );
});
