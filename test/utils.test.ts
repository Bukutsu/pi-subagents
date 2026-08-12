import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireSessionLock,
  isSubagentRecord,
  resolveSubagentCwd,
  sanitizeForkMessages,
  sanitizeTerminalOutput,
  usageSince,
} from "../src/utils.js";
import type { SubagentRecord } from "../src/types.js";

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

test("sanitizeForkMessages strips bg/subagent calls and creates un-mutated message copies", () => {
  const userMsg = { role: "user", content: "hello" };
  const assistantMsg = {
    role: "assistant",
    content: [
      { type: "text", text: "ok" },
      { type: "toolCall", id: "call-1", name: "read" },
      { type: "toolCall", id: "call-2", name: "bg" },
    ],
  };
  const toolResult = {
    role: "toolResult",
    toolCallId: "call-1",
    content: "file content",
  };

  const mockCtx: any = {
    sessionManager: {
      getBranch: () => [
        { type: "message", id: "1", parentId: null, message: userMsg },
        { type: "message", id: "2", parentId: "1", message: assistantMsg },
        { type: "message", id: "3", parentId: "2", message: toolResult },
      ],
    },
  };

  const sanitized = sanitizeForkMessages(mockCtx);
  assert.equal(sanitized.length, 3);
  assert.notEqual(sanitized[0], userMsg); // Shallow copy check
  assert.deepEqual(sanitized[0], userMsg);
  const toolCalls = sanitized[1].content.filter(
    (c: any) => c.type === "toolCall",
  );
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].name, "read");
});
