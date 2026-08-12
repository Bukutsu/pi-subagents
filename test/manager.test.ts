import assert from "node:assert/strict";
import test from "node:test";
import { SubagentManager } from "../src/manager.js";

test("does not deliver results after navigating away from the origin branch", () => {
  const messages: unknown[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  const ctx: any = {
    isIdle: () => true,
    sessionManager: {
      getLeafId: () => "leaf-2",
      getBranch: () => [{ id: "leaf-2" }],
    },
  };
  manager.currentCtx = ctx;

  manager.deliverCompletion("result", "continue", 1, "leaf-1");

  assert.equal(messages.length, 0);
});

test("killAllJobs aborts active subagents and pending setup", () => {
  const manager = new SubagentManager({} as any);
  const first = new AbortController();
  const second = new AbortController();
  const setup = new AbortController();
  manager.jobs.set(1, { controller: first } as any);
  manager.jobs.set(2, { controller: second } as any);
  const release = manager.trackSetup(setup);

  assert.equal(manager.killAllJobs(), 3);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(setup.signal.aborted, true);
  assert.equal(manager.killAllJobs(), 0);

  release();
});
