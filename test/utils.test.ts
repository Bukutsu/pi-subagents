import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireSessionLock,
  atomicWriteFileSync,
  displayText,
  isSubagentRecord,
  readIndex,
  resolveSubagentCwd,
  sanitizeTerminalOutput,
  usageSince,
} from "../src/utils.js";
import { retainLog, type SubagentRecord } from "../src/types.js";

const record: SubagentRecord = {
  sessionId: "session-1",
  cwd: process.cwd(),
  sessionFile: "/tmp/session.jsonl",
  model: "provider/model",
  label: "test",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  state: "finished",
  turns: 1,
  toolCount: 2,
  toolFailures: 0,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    total: 10,
    cost: 0.01,
  },
  inheritedTools: ["read"],
  context: "project",
};

test("accepts complete records and rejects incomplete durable records", () => {
  assert.equal(isSubagentRecord(record), true);
  assert.equal(isSubagentRecord({ ...record, usage: undefined }), false);
  assert.equal(isSubagentRecord({ ...record, context: undefined }), false);
  assert.equal(isSubagentRecord({ ...record, turns: undefined }), false);
});

test("handles absent usage fields and strips terminal control sequences", () => {
  assert.deepEqual(
    usageSince(
      { tokens: { input: 4, total: 4 }, cost: 0.3 } as any,
      { tokens: { input: 1, total: 1 }, cost: 0.1 } as any,
    ),
    {
      input: 3,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 3,
      cost: 0.19999999999999998,
    },
  );
  assert.equal(sanitizeTerminalOutput("ok\x1b[31m unsafe\x1b[0m"), "ok unsafe");
  assert.equal(
    displayText([{ type: "text", text: "machine" }], {
      displayText: "human",
    }),
    "human",
  );
});

test("resolveSubagentCwd resolves valid directories and rejects non-existent paths", () => {
  const cwd = process.cwd();
  assert.equal(resolveSubagentCwd(cwd, "."), cwd);
  assert.equal(resolveSubagentCwd(cwd, "src"), `${cwd}/src`);
  assert.equal(resolveSubagentCwd(cwd, "@src"), `${cwd}/src`);
  assert.throws(
    () => resolveSubagentCwd(cwd, "non-existent-dir-12345"),
    /cwd does not exist/,
  );
});

test("resolveSubagentCwd rejects paths outside the parent and escaping symlinks", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-subagent-parent-"));
  const outside = mkdtempSync(join(tmpdir(), "pi-subagent-outside-"));
  const link = join(parent, "outside-link");
  symlinkSync(outside, link, "dir");
  try {
    assert.throws(
      () => resolveSubagentCwd(parent, outside),
      /must remain inside the parent project/,
    );
    assert.throws(
      () => resolveSubagentCwd(parent, "../"),
      /must remain inside the parent project/,
    );
    assert.throws(
      () => resolveSubagentCwd(parent, "outside-link"),
      /must remain inside the parent project/,
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("reads records from the index directory", () => {
  const sessionId = `historic-${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-index-"));
  const file = join(dir, `${sessionId}.json`);
  const historic = { ...record, sessionId };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(historic));
  try {
    assert.deepEqual(readIndex([dir])[sessionId], historic);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireSessionLock acquires and cleans up locks", () => {
  const sessionId = `test-lock-${Date.now()}`;
  const lock = acquireSessionLock(sessionId);
  assert.ok(lock.endsWith(sessionId));
  assert.throws(
    () => acquireSessionLock(sessionId),
    /already running in process/,
  );
  rmSync(lock, { recursive: true, force: true });
});

test("serializeModelJson enforces the final byte cap", async () => {
  const { MODEL_OUTPUT_MAX_BYTES, serializeModelJson } =
    await import("../src/utils.js");
  const serialized = serializeModelJson({
    v: 1,
    type: "subagent",
    output: '"\\'.repeat(MODEL_OUTPUT_MAX_BYTES),
  });
  assert.ok(Buffer.byteLength(serialized) <= MODEL_OUTPUT_MAX_BYTES);
  assert.equal(JSON.parse(serialized).outputTruncated, true);
});

test("retainLog uses timestamp-prefixed filenames for chronological sorting", () => {
  const logPath = retainLog("test log content");
  if (logPath) {
    const filename = logPath.split("/").pop() ?? "";
    assert.match(filename, /^\d+-[0-9a-f-]+\.log$/);
  }
});

test("atomicWriteFileSync writes file safely without temporary residues", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-atomic-test-"));
  const target = join(dir, "data.json");
  atomicWriteFileSync(target, '{"hello":"world"}');
  assert.equal(readFileSync(target, "utf8"), '{"hello":"world"}');
  rmSync(dir, { recursive: true, force: true });
});
