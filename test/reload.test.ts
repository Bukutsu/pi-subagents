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
      session: { getSessionStats: () => ({ assistantMessages: 0, toolCalls: 0 }) },
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
    assert.equal(restored?.handedOff, false, "in-process reload preserves live job");
    assert.notEqual(restored?.activity, "finishing (session reload)");

    // Stopping the job in the new manager directly aborts the live controller.
    const stopped = newManager.killJob(100);
    assert.equal(stopped, true);
    assert.equal(childController.signal.aborted, true, "killJob directly aborts controller");

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
