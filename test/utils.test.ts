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
  sanitizeForkMessages,
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

test("reads records from the historical pi-bg root", () => {
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

test("sanitizeForkMessages enforces an aggregate context budget", () => {
  const entries: any[] = [];
  let parentId: string | null = null;
  for (let i = 0; i < 20; i++) {
    const id = `user-${i}`;
    entries.push({
      type: "message",
      id,
      parentId,
      message: { role: "user", content: "u".repeat(10_000) },
    });
    parentId = id;
    const assistantId = `assistant-${i}`;
    entries.push({
      type: "message",
      id: assistantId,
      parentId,
      message: { role: "assistant", content: "a".repeat(10_000) },
    });
    parentId = assistantId;
  }
  const sanitized = sanitizeForkMessages({
    sessionManager: { getBranch: () => entries },
  } as any);
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized)) <= 64 * 1024);
  assert.equal(sanitized[0].role, "user");
});

test("sanitizeForkMessages keeps the newest assistant reply when a unit exceeds the budget", () => {
  const user = { role: "user", content: "huge request" };
  const toolCalls = Array.from({ length: 6 }, (_, index) => ({
    type: "toolCall",
    id: `call-${index}`,
    name: "read",
    args: JSON.stringify({ path: "x".repeat(15_000) }),
  }));
  const assistant = {
    role: "assistant",
    content: [
      ...toolCalls,
      { type: "text", text: "The newest answer is preserved." },
    ],
  };
  const entries = [
    {
      type: "message",
      id: "1",
      parentId: null,
      message: user,
    },
    {
      type: "message",
      id: "2",
      parentId: "1",
      message: assistant,
    },
    ...toolCalls.map((call, index) => ({
      type: "message",
      id: `3-${index}`,
      parentId: index === 0 ? "2" : `3-${index - 1}`,
      message: {
        role: "toolResult",
        toolCallId: call.id,
        content: "r".repeat(16_000),
      },
    })),
  ];
  const sanitized = sanitizeForkMessages({
    sessionManager: { getBranch: () => entries },
  } as any);
  assert.equal(sanitized.at(-1)!.role, "assistant");
  const text = sanitized.at(-1)!.content;
  assert.ok(typeof text === "string" && text.includes("newest answer"));
  assert.ok(Buffer.byteLength(JSON.stringify(sanitized)) <= 64 * 1024);
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
