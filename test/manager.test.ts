import assert from "node:assert/strict";
import test from "node:test";
import { SubagentManager } from "../src/manager.js";

test("keeps results until the origin branch is active", () => {
  const messages: unknown[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  let branch = [{ id: "leaf-2" }];
  const ctx: any = {
    isIdle: () => true,
    sessionManager: {
      getLeafId: () => branch.at(-1)?.id ?? null,
      getBranch: () => branch,
    },
  };
  manager.currentCtx = ctx;

  manager.deliverCompletion("result", "continue", 1, "leaf-1");
  assert.equal(messages.length, 0);

  branch = [{ id: "leaf-1" }];
  (manager as any).flushPendingCompletions(ctx);
  assert.equal(messages.length, 1);
});

test("batches queued completions after the parent settles", () => {
  const messages: any[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  let idle = false;
  const ctx: any = {
    isIdle: () => idle,
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };
  manager.currentCtx = ctx;

  manager.deliverCompletion('{"sessionId":"one"}', "queue", 1, "leaf-1");
  manager.deliverCompletion('{"sessionId":"two"}', "queue", 1, "leaf-1");
  assert.equal(messages.length, 0);

  idle = true;
  (manager as any).flushPendingCompletions(ctx);
  assert.equal(messages.length, 1);
  assert.equal(JSON.parse(messages[0].content).results.length, 2);
});

test("coalesces multiple continue completions on the same origin branch", () => {
  const messages: any[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  const ctx: any = {
    isIdle: () => true,
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };
  manager.currentCtx = ctx;

  (manager as any).pendingCompletions.push({
    message: '{"sessionId":"child-1","output":"done 1"}',
    completion: "continue",
    expectedGeneration: 1,
    originLeafId: "leaf-1",
    triggerTurn: true,
  });
  (manager as any).pendingCompletions.push({
    message: '{"sessionId":"child-2","output":"done 2"}',
    completion: "continue",
    expectedGeneration: 1,
    originLeafId: "leaf-1",
    triggerTurn: true,
  });

  (manager as any).flushPendingCompletions(ctx);
  assert.equal(messages.length, 1);
  const parsed = JSON.parse(messages[0].content);
  assert.equal(parsed.event, "batch");
  assert.equal(parsed.results.length, 2);
});

test("keeps queued batches separated by origin and byte budget", () => {
  const messages: any[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  let idle = false;
  const ctx: any = {
    isIdle: () => idle,
    sessionManager: {
      getLeafId: () => "leaf-2",
      getBranch: () => [{ id: "leaf-1" }, { id: "leaf-2" }],
    },
  };
  manager.currentCtx = ctx;
  const large = JSON.stringify({ output: "x".repeat(10_000) });

  manager.deliverCompletion(large, "queue", 1, "leaf-1");
  manager.deliverCompletion(large, "queue", 1, "leaf-1");
  manager.deliverCompletion('{"sessionId":"two"}', "queue", 1, "leaf-2");
  idle = true;
  (manager as any).flushPendingCompletions(ctx);

  assert.equal(messages.length, 3);
  assert.ok(
    messages.every(
      (message) => Buffer.byteLength(message.content) <= 16 * 1024,
    ),
  );
});

test("deduplicates completion delivery by invocation", () => {
  const messages: unknown[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  manager.currentCtx = {
    isIdle: () => true,
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  } as any;

  manager.deliverCompletion(
    "result",
    "queue",
    1,
    "leaf-1",
    true,
    "completion-1",
  );
  manager.deliverCompletion(
    "result",
    "queue",
    1,
    "leaf-1",
    true,
    "completion-1",
  );
  assert.equal(messages.length, 1);
});

test("marks stopped subagents while cancellation is in progress", () => {
  const manager = new SubagentManager({} as any);
  const controller = new AbortController();
  manager.jobs.set(1, { controller } as any);

  assert.equal(manager.killJob(1), true);
  assert.equal((manager.jobs.get(1) as any).stopping, true);
  assert.equal(controller.signal.aborted, true);
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
