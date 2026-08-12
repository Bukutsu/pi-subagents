import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readIndex } from "../src/utils.js";
import type { SubagentRecord } from "../src/types.js";

function record(sessionId: string, model: string): SubagentRecord {
  return {
    sessionId,
    cwd: process.cwd(),
    sessionFile: join(tmpdir(), `${sessionId}.jsonl`),
    model,
    label: "integration",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: "finished",
    turns: 1,
    toolCount: 1,
    toolFailures: 0,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      total: 2,
      cost: 0,
    },
    inheritedTools: ["read"],
    context: "project",
  };
}

test("loads historical records and lets the current index win", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-subagent-roots-"));
  const historic = join(root, "historic");
  const current = join(root, "current");
  mkdirSync(historic);
  mkdirSync(current);
  writeFileSync(
    join(historic, "session-1.json"),
    JSON.stringify(record("session-1", "provider/old")),
  );
  writeFileSync(
    join(current, "session-1.json"),
    JSON.stringify(record("session-1", "provider/new")),
  );
  try {
    assert.equal(
      readIndex([historic, current])["session-1"].model,
      "provider/new",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
