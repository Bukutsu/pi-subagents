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

test("reload keeps the child running and restores a display-only job", async () => {
  const handoffDir = mkdtempSync(join(tmpdir(), "pi-sub-handoff-"));
  try {
    const { pi: oldPi, handlers: oldHandlers } = createFakePi();
    const oldManager = new SubagentManager(oldPi as any);
    oldManager.handoffDir = handoffDir;
    oldManager.init();
    await oldHandlers.get("session_start")!(undefined, createCtx());
    const childController = new AbortController();
    oldManager.jobs.set(1, {
      pid: 1,
      command: "Subagent: audit",
      startedAt: Date.now(),
      sessionId: "session-abc",
      controller: childController,
      completionId: "completion-reload-s1",
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
    } as any);

    await oldHandlers.get("session_shutdown")!(
      { reason: "reload" },
      createCtx(),
    );
    assert.equal(childController.signal.aborted, false, "child keeps running");

    // New runtime restores the job for status and delivers the result.
    const { pi: newPi, handlers: newHandlers, messages } = createFakePi();
    const newManager = new SubagentManager(newPi as any);
    newManager.handoffDir = handoffDir;
    newManager.init();
    await newHandlers.get("session_start")!({ reason: "reload" }, createCtx());
    const restored = newManager.jobs.get(1);
    assert.equal(restored?.handedOff, true);
    assert.equal(restored?.activity, "finishing (session reload)");

    // Simulate the old runtime finishing: result appears in the handoff dir
    // and the new runtime delivers it on the next drain.
    const entryPath = join(handoffDir, "completion-reload-s1.json");
    newManager.writeHandoffResult(entryPath, {
      message:
        '{"v":1,"type":"subagent","event":"complete","state":"finished","sessionId":"session-abc"}',
      displayMessage: "Background subagent finished: audit",
      details: { sessionId: "session-abc" },
      triggerTurn: true,
    });
    (newManager as any).drainHandoffs(createCtx());
    assert.equal(messages.length, 1);
    assert.equal(messages[0].customType, "pi-subagent-result");
    assert.equal(newManager.jobs.has(1), false);
  } finally {
    rmSync(handoffDir, { recursive: true, force: true });
  }
});
