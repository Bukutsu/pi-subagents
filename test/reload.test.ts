import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SubagentManager } from "../src/manager.js";

function createFakePi() {
  const handlers = new Map<string, (event: any, ctx: any) => Promise<void>>();
  const messages: any[] = [];
  return {
    pi: {
      registerMessageRenderer: () => {},
      on: (event: string, handler: (event: any, ctx: any) => Promise<void>) =>
        handlers.set(event, handler),
      sendMessage: (message: unknown) => messages.push(message),
    },
    handlers,
    messages,
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

test("reload preserves live in-process subagent job across extension reload", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
    oldManager.init();
    await oldHandlers.get("session_start")!(undefined, createCtx());
    const childController = new AbortController();
    oldManager.jobs.set(100, {
      pid: 100,
      command: "Subagent: audit",
      startedAt: Date.now(),
      sessionId: "session-abc",
      controller: childController,
      completionId: "completion-reload-s1",
      forceCleanup: () => {},
      session: {
        getSessionStats: () => ({ assistantMessages: 0, toolCalls: 0 }),
      },
      activity: "thinking",
      baseline: { assistantMessages: 0, toolCalls: 0 },
      record: { sessionId: "session-abc", cwd: process.cwd(), model: "test" },
      toolFailures: 0,
      completion: "queue",
      originLeafId: "leaf-1",
      expectedGeneration: oldManager.generation,
      originSessionFile: "",
    } as any);

    await oldHandlers.get("session_shutdown")!(
      { reason: "reload" },
      createCtx(),
    );
    assert.equal(childController.signal.aborted, false, "child keeps running");

    // New runtime adopts the live job directly in-process.
    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    await newHandlers.get("session_start")!({ reason: "reload" }, createCtx());
    const restored = newManager.jobs.get(100);
    assert.equal(
      restored?.handedOff,
      false,
      "in-process reload preserves live job",
    );
    assert.notEqual(restored?.activity, "finishing (session reload)");

    // Stopping the job in the new manager directly aborts the live controller.
    const stopped = newManager.killJob(100);
    assert.equal(stopped, true);
    assert.equal(
      childController.signal.aborted,
      true,
      "killJob directly aborts controller",
    );

    // Clean up
    newManager.jobs.delete(100);
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("cross-process file handoff restores and delivers completion", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
    oldManager.init();
    await oldHandlers.get("session_start")!(undefined, createCtx());
    const childController = new AbortController();
    const handedOffJob = {
      pid: 200,
      command: "Subagent: cross process audit",
      startedAt: Date.now(),
      sessionId: "session-xyz",
      controller: childController,
      completionId: "completion-reload-s2",
      forceCleanup: () => {},
      session: { getSessionStats: () => ({}) },
      activity: "thinking",
      baseline: { assistantMessages: 0, toolCalls: 0 },
      record: {},
      toolFailures: 0,
      completion: "queue",
      originLeafId: "leaf-1",
      expectedGeneration: oldManager.generation,
      originSessionFile: "",
    } as any;
    oldManager.jobs.set(200, handedOffJob);

    await oldHandlers.get("session_shutdown")!(
      { reason: "reload" },
      createCtx(),
    );

    // Remove job from global map to simulate cross-process startup in a fresh process
    (globalThis as any).__PI_SUBAGENTS_ACTIVE_JOBS__?.delete(200);

    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    await newHandlers.get("session_start")!({ reason: "reload" }, createCtx());
    const restored = newManager.jobs.get(200);
    assert.equal(restored?.handedOff, true);
    assert.equal(restored?.activity, "finishing (session reload)");

    // Simulate result written to file handoff
    const entryPath = join(handoffDir, "completion-reload-s2.json");
    newManager.writeHandoffResult(entryPath, {
      message:
        '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-xyz"}',
      displayMessage: "Background subagent finished: cross process audit",
      details: { sessionId: "session-xyz" },
      triggerTurn: true,
    });
    (newManager as any).drainHandoffs(createCtx());
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "pi-subagent-result");
    assert.equal(newManager.jobs.has(200), false);
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("in-process reload delivers completion when job finishes after reload", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
    oldManager.init();
    await oldHandlers.get("session_start")!(undefined, createCtx());

    const childController = new AbortController();
    const job = {
      pid: 300,
      command: "Subagent: round 2 audit",
      startedAt: Date.now(),
      sessionId: "session-300",
      controller: childController,
      completionId: "completion-300",
      forceCleanup: () => {},
      session: {
        getSessionStats: () => ({ assistantMessages: 1, toolCalls: 2 }),
      },
      activity: "thinking",
      baseline: { assistantMessages: 0, toolCalls: 0 },
      record: { sessionId: "session-300", cwd: process.cwd(), model: "test" },
      toolFailures: 0,
      completion: "continue",
      originLeafId: "leaf-1",
      expectedGeneration: oldManager.generation,
      originSessionFile: "session-300.jsonl",
      originSessionId: "reload-session",
    } as any;
    oldManager.jobs.set(300, job);

    // Simulate session reload
    await oldHandlers.get("session_shutdown")!(
      { reason: "reload" },
      createCtx("session-300.jsonl"),
    );

    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    await newHandlers.get("session_start")!(
      { reason: "reload" },
      createCtx("session-300.jsonl"),
    );

    assert.equal(job.expectedGeneration, newManager.generation);

    // Job finishes after reload and delivers using its updated expectedGeneration
    newManager.deliverCompletion(
      '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-300"}',
      "continue",
      job.expectedGeneration,
      "leaf-1",
      true,
      "completion-300",
      "Audit finished",
      { sessionId: "session-300" },
    );

    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "pi-subagent-result");

    newManager.jobs.delete(300);
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("syncStatus gracefully ignores stale context errors during reload", () => {
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

  // Calling syncStatus with a throwing/stale context must not throw
  assert.doesNotThrow(() => {
    manager.syncStatus(staleCtx);
  });
});

test("pending completions queued before reload are flushed to reloaded session", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
    oldManager.init();
    let idle = false;
    const ctx = {
      ...createCtx("session-queue.jsonl"),
      isIdle: () => idle,
    };
    await oldHandlers.get("session_start")!(undefined, ctx);

    // Queue a completion while parent is busy before reload
    oldManager.deliverCompletion(
      '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-queued"}',
      "continue",
      oldManager.generation,
      "leaf-1",
      false, // triggerTurn false + idle false -> will queue
      "completion-queued-1",
    );

    // Reload
    await oldHandlers.get("session_shutdown")!({ reason: "reload" }, ctx);

    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    idle = true; // now idle in reloaded session
    await newHandlers.get("session_start")!({ reason: "reload" }, ctx);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "pi-subagent-result");
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});

test("session switch does not clobber other session jobs or handoffs", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
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
      record: { sessionId: "session-A-sub", cwd: process.cwd(), model: "test" },
      toolFailures: 0,
      completion: "continue",
      originLeafId: "leaf-A",
      expectedGeneration: oldManager.generation,
      originSessionFile: "session-A.jsonl",
      originSessionId: "session-A-id",
    } as any;
    oldManager.jobs.set(400, jobA);

    // Switch to session B
    await oldHandlers.get("session_shutdown")!(
      { reason: "resume" },
      ctxSessionA,
    );

    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    const ctxSessionB = {
      ...createCtx("session-B.jsonl"),
      sessionManager: {
        getLeafId: () => "leaf-B",
        getBranch: () => [{ id: "leaf-B" }],
        getEntries: () => [],
        getSessionId: () => "session-B-id",
        getSessionFile: () => "session-B.jsonl",
      },
    };
    await newHandlers.get("session_start")!({ reason: "resume" }, ctxSessionB);

    // Job A should retain its originSessionId/File and not deliver to Session B
    assert.equal(jobA.originSessionId, "session-A-id");
    assert.equal(jobA.originSessionFile, "session-A.jsonl");
    assert.equal(messages.length, 0, "must not deliver to Session B");

    // Clean up
    newManager.jobs.delete(400);
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});
