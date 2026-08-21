import assert from "node:assert/strict";
import test from "node:test";
import { SubagentManager } from "../src/manager.js";

test("tracks active jobs and setup reservations", () => {
  const manager = new SubagentManager({} as any);
  assert.equal(manager.activeCount(), 0);

  const releaseSetup = manager.trackSetup(new AbortController());
  assert.equal(manager.activeCount(), 1);
  manager.jobs.set(1, {} as any);
  assert.equal(manager.activeCount(), 2);

  releaseSetup();
  manager.jobs.delete(1);
  assert.equal(manager.activeCount(), 0);
});

test("allows unbounded concurrent setup reservations across manager instances", () => {
  const first = new SubagentManager({} as any);
  const second = new SubagentManager({} as any);
  const releaseFirst = first.trackSetup(new AbortController());
  const releaseSecond = second.trackSetup(new AbortController());

  // Setup reservations are process-global, so each instance sees both.
  assert.equal(first.activeCount(), 2);
  assert.equal(second.activeCount(), 2);

  releaseFirst();
  releaseSecond();
});

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

  assert.equal(messages.length, 2);
  assert.ok(
    messages.every(
      (message) => Buffer.byteLength(message.content) <= 16 * 1024,
    ),
  );
  assert.equal(JSON.parse(messages[0].content).event, "batch");
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
  const setup = new AbortController();
  manager.jobs.set(1, { controller: first } as any);
  const release = manager.trackSetup(setup);

  assert.equal(manager.killAllJobs(), 2);
  assert.equal(first.signal.aborted, true);
  assert.equal(setup.signal.aborted, true);
  assert.equal(manager.killAllJobs(), 0);

  release();
});

test("emits subagent:stop event on pi.events when killing a job", () => {
  const events: Array<{ name: string; data: any }> = [];
  const pi: any = {
    events: {
      emit: (name: string, data: any) => events.push({ name, data }),
    },
  };
  const manager = new SubagentManager(pi);
  const controller = new AbortController();
  manager.jobs.set(1, {
    sessionId: "test-session-123",
    controller,
  } as any);

  assert.equal(manager.killJob(1), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "subagent:stop");
  assert.equal(events[0].data.pid, 1);
  assert.equal(events[0].data.sessionId, "test-session-123");
});

test("flushes queued completions when the parent agent settles", async () => {
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  const messages: unknown[] = [];
  const manager = new SubagentManager({
    registerMessageRenderer: () => {},
    on: (event: string, handler: (event: unknown, ctx: any) => unknown) =>
      handlers.set(event, handler),
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.init();
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

  manager.deliverCompletion("queued", "queue", 1, "leaf-1");
  assert.equal(messages.length, 0);
  idle = true;
  await handlers.get("agent_settled")!(undefined, ctx);
  assert.equal(messages.length, 1);
});

test("passes triggerTurn: false when delivering follow-up queue completions during active turns", () => {
  const calls: Array<{ message: unknown; options: unknown }> = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown, options: unknown) =>
      calls.push({ message, options }),
  } as any);
  const ctx: any = {
    isIdle: () => false,
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  (manager as any).sendCompletionMessage(
    "queued result",
    "queue",
    "leaf-1",
    false,
    ctx,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options, {
    deliverAs: "followUp",
    triggerTurn: false,
  });
});

test("killJob is idempotent for a known pid that is already stopping", () => {
  const manager = new SubagentManager({} as any);
  const controller = new AbortController();
  controller.abort();
  manager.jobs.set(1, { controller } as any);

  assert.equal(manager.killJob(1), true);
  assert.equal(manager.killJob(1), true);
});

test("oversized completions are shrunk to the parent delivery budget", () => {
  const messages: unknown[] = [];
  const manager = new SubagentManager({
    sendMessage: (message: unknown) => messages.push(message),
  } as any);
  manager.shuttingDown = false;
  manager.generation = 1;
  const ctx: any = {
    isIdle: () => true,
    model: { contextWindow: 32768 },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };
  manager.currentCtx = ctx;

  const oversized = JSON.stringify({
    type: "subagent",
    output: '"\\'.repeat(4096),
  });
  manager.deliverCompletion(oversized, "continue", 1, "leaf-1");
  assert.equal(messages.length, 1);
  const content = (messages[0] as any).content as string;
  assert.ok(
    Buffer.byteLength(content) <= 4096,
    "delivered message must fit the parent budget",
  );
  const parsed = JSON.parse(content);
  assert.equal(parsed.event, "batch");
  assert.equal(parsed.results[0].outputTruncated, true);
});
