import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEtime, parseScan, restoreScript } from "./itermLayout.js";

test("reads ps etime in all its shapes", () => {
  assert.equal(parseEtime("05:07"), 307);
  assert.equal(parseEtime("01:27:45"), 5265);
  assert.equal(parseEtime("2-03:00:01"), 183601);
  assert.equal(parseEtime("garbage"), null);
});

test("parses windows, tabs and panes from the scan output", () => {
  const out = "W|0,34,1728,1027\nT\nS|/dev/ttys001\nS|/dev/ttys002\nT\nS|/dev/ttys004\nW|10,20,800,600\nT\nS|/dev/ttys009\n";
  assert.deepEqual(parseScan(out), [
    { bounds: [0, 34, 1728, 1027], tabs: [["/dev/ttys001", "/dev/ttys002"], ["/dev/ttys004"]] },
    { bounds: [10, 20, 800, 600], tabs: [["/dev/ttys009"]] },
  ]);
});

test("restores tabs in order, splits extra panes and resumes Claude in its folder", () => {
  const script = restoreScript(
    [
      {
        bounds: [0, 34, 1728, 1027],
        tabs: [
          [{ kind: "claude", sessionId: "abc", cwd: "/repo/a", account: "work" }, { kind: "shell", cwd: "/repo/a" }],
          [{ kind: "shell", cwd: '/repo/"b"' }],
        ],
      },
    ],
    (account) => (account === "work" ? "/Users/x/.claude-work" : null),
  );
  const lines = script.split("\n");
  assert.ok(lines.includes("set bounds of w to {0, 34, 1728, 1027}"));
  assert.ok(lines.includes('tell s to write text "cd \\"/repo/a\\" && CLAUDE_CONFIG_DIR=\\"/Users/x/.claude-work\\" claude --resume abc"'));
  const split = lines.indexOf("tell s to set s to (split vertically with default profile)");
  const newTab = lines.indexOf("tell w to set t to (create tab with default profile)");
  assert.ok(split > 0 && newTab > split);
  assert.ok(lines.includes('tell s to write text "cd \\"/repo/\\\\\\"b\\\\\\"\\""'));
});
