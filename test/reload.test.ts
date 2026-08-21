import assert from "node:assert/strict";
import { afterEach } from "node:test";
import test from "node:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SubagentManager } from "../src/manager.js";
import { SUBAGENT_INDEX } from "../src/types.js";
import type { SubagentRecord } from "../src/types.js";

function createFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const messages: any[] = [];
  return {
    pi: {
      registerMessageRenderer: () => {},
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) =>
        handlers.set(event, handler),
      sendMessage: (message: unknown) => messages.push(message),
      events: { emit: () => {} },
    },
    handlers,
    messages,
  };
}

/** Clear the global jobs map to prevent cross-test pollution. */
function clearGlobalJobs() {
  (globalThis as any).__PI_SUBAGENTS_ACTIVE_JOBS__?.clear();
}

const TEST_SESSION_IDS = [
  "session-abc",
  "session-quit",
  "session-block",
  "session-A-sub",
];

afterEach(() => {
  for (const sessionId of TEST_SESSION_IDS) {
    rmSync(join(SUBAGENT_INDEX, `${sessionId}.json`), { force: true });
  }
});

function createTestRecord(sessionId: string): SubagentRecord {
  const now = new Date().toISOString();
  return {
    sessionId,
    cwd: process.cwd(),
    sessionFile: "",
    model: "test",
    label: "test",
    createdAt: now,
    updatedAt: now,
    state: "running",
    turns: 0,
    toolCount: 0,
    toolFailures: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      cost: 0,
    },
    inheritedTools: [],
    context: "project",
    ownerPid: process.pid,
  };
}

function createCtx(sessionFile: string | undefined = undefined) {
  return {
    isIdle: () => true,
    ui: {
      setStatus: () => {},
      setWidget: () => {},
      notify: () => {},
    },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
      getEntries: () => [],
      getSessionId: () => "reload-session",
      getSessionFile: () => sessionFile,
    },
  };
}

test("extension reload waits for running subagents", async () => {
  clearGlobalJobs();
  const { pi: oldPi, handlers: oldHandlers } = createFakePi();
  const oldManager = new SubagentManager(oldPi as any);
  oldManager.init();
  await oldHandlers.get("session_start")!(undefined, createCtx());
  oldManager.jobs.set(100, {
    pid: 100,
    command: "Subagent: audit",
    startedAt: Date.now(),
    sessionId: "session-abc",
    controller: new AbortController(),
    forceCleanup: () => {},
  } as any);

  let finished = false;
  const shutdown = oldHandlers.get("session_shutdown")!(
    { reason: "reload" },
    createCtx(),
  );
  shutdown.then(() => {
    finished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(finished, false, "reload remains blocked while job is running");

  oldManager.jobs.delete(100);
  await shutdown;
  assert.equal(finished, true, "reload continues after job stops");
});

test("quit cleans up all jobs", async () => {
  clearGlobalJobs();
  const { pi: oldPi, handlers: oldHandlers } = createFakePi();
  const oldManager = new SubagentManager(oldPi as any);
  oldManager.init();
  oldManager.shuttingDown = false;
  await oldHandlers.get("session_start")!(undefined, createCtx());
  oldManager.jobs.set(200, {
    pid: 200,
    command: "Subagent: quit test",
    startedAt: Date.now(),
    sessionId: "session-quit",
    controller: new AbortController(),
    completionId: "completion-quit",
    forceCleanup: () => {},
    session: {
      getSessionStats: () => ({ assistantMessages: 1, toolCalls: 1 }),
    },
    activity: "thinking",
    baseline: { assistantMessages: 0, toolCalls: 0 },
    record: createTestRecord("session-quit"),
    toolFailures: 0,
    completion: "queue",
    originLeafId: "leaf-1",
    expectedGeneration: oldManager.generation,
    originSessionFile: "",
  } as any);

  await oldHandlers.get("session_shutdown")!({ reason: "quit" }, createCtx());
  const job = oldManager.jobs.get(200);
  assert.notEqual(job, undefined, "job still in map after quit");
  assert.equal(job?.stoppedManually, true, "job marked as stoppedManually");
  assert.equal(job?.stopping, true, "job marked as stopping");
  assert.equal(
    job?.record.state,
    "interrupted",
    "job record state is interrupted",
  );
});

test("session switch is blocked when subagents are running", async () => {
  clearGlobalJobs();
  const { pi, handlers } = createFakePi();
  const manager = new SubagentManager(pi as any);
  manager.init();
  await handlers.get("session_start")!(undefined, createCtx());
  manager.jobs.set(300, {
    pid: 300,
    command: "Subagent: blocking test",
    startedAt: Date.now(),
    sessionId: "session-block",
    controller: new AbortController(),
    completionId: "completion-block",
    forceCleanup: () => {},
    session: {
      getSessionStats: () => ({ assistantMessages: 0, toolCalls: 0 }),
    },
    activity: "thinking",
    baseline: { assistantMessages: 0, toolCalls: 0 },
    record: createTestRecord("session-block"),
    toolFailures: 0,
    completion: "queue",
    originLeafId: "leaf-1",
    expectedGeneration: manager.generation,
    originSessionFile: "",
  } as any);

  const notifyMessages: string[] = [];
  const switchCtx = {
    ...createCtx(),
    ui: {
      ...createCtx().ui,
      notify: (msg: string) => notifyMessages.push(msg),
    },
  };

  for (const event of [
    "session_before_switch",
    "session_before_fork",
    "session_before_tree",
  ]) {
    manager.jobs.set(300, {
      pid: 300,
      command: "Subagent: blocking test",
      startedAt: Date.now(),
      sessionId: "session-block",
      controller: new AbortController(),
      forceCleanup: () => {},
    } as any);
    const result = await handlers.get(event)!({ reason: "resume" }, switchCtx);
    assert.deepEqual(result, { cancel: true }, `${event} is blocked`);
    manager.jobs.delete(300);
  }
  assert.ok(
    notifyMessages.length >= 3 &&
      notifyMessages.every((m) => m.includes("subagent")),
    "notifies user about running subagents",
  );
});

test("syncStatus gracefully ignores stale context errors", () => {
  clearGlobalJobs();
  const { pi } = createFakePi();
  const manager = new SubagentManager(pi as any);
  manager.shuttingDown = false;

  const staleCtx: any = {
    get ui() {
      throw new Error(
        "This extension ctx is stale after session replacement or reload.",
      );
    },
  };

  assert.doesNotThrow(() => {
    manager.syncStatus(staleCtx);
  });
});

test("pending completions queued before quit are dropped", async () => {
  clearGlobalJobs();
  const { pi, handlers, messages } = createFakePi();
  const manager = new SubagentManager(pi as any);
  manager.init();
  manager.shuttingDown = false;
  const ctx = createCtx();
  await handlers.get("session_start")!(undefined, ctx);

  manager.deliverCompletion(
    '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-dropped"}',
    "queue",
    manager.generation,
    "leaf-1",
    false,
    "completion-drop-1",
  );

  await handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
  // After quit, no more completions should be delivered
  manager.shuttingDown = true;
  manager.deliverCompletion(
    '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-after-quit"}',
    "continue",
    manager.generation,
    "leaf-1",
    true,
    "completion-after-quit",
  );
  // Only the first (pre-quit) completion should be in messages
  assert.equal(messages.length, 1);
});

test("session switch does not clobber other session jobs", async () => {
  clearGlobalJobs();
  const { pi: oldPi, handlers: oldHandlers } = createFakePi();
  const oldManager = new SubagentManager(oldPi as any);
  oldManager.init();
  const ctxSessionA = {
    ...createCtx("session-A.jsonl"),
    sessionManager: {
      getLeafId: () => "leaf-A",
      getBranch: () => [{ id: "leaf-A" }],
      getEntries: () => [],
      getSessionId: () => "session-A-id",
      getSessionFile: () => "session-A.jsonl",
    },
  };
  await oldHandlers.get("session_start")!(undefined, ctxSessionA);

  const jobA = {
    pid: 400,
    command: "Subagent: session A job",
    startedAt: Date.now(),
    sessionId: "session-A-sub",
    controller: new AbortController(),
    completionId: "completion-session-A",
    forceCleanup: () => {},
    session: {
      getSessionStats: () => ({ assistantMessages: 1, toolCalls: 1 }),
    },
    activity: "thinking",
    baseline: { assistantMessages: 0, toolCalls: 0 },
    record: createTestRecord("session-A-sub"),
    toolFailures: 0,
    completion: "continue",
    originLeafId: "leaf-A",
    expectedGeneration: oldManager.generation,
    originSessionFile: "session-A.jsonl",
  } as any;
  oldManager.jobs.set(400, jobA);

  // session_before_switch should block because jobA is running
  const blockResult = await oldHandlers.get("session_before_switch")!(
    { reason: "resume" },
    ctxSessionA,
  );
  assert.deepEqual(blockResult, { cancel: true });

  oldManager.jobs.delete(400);
});
