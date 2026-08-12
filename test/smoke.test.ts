import assert from "node:assert/strict";
import test from "node:test";
import { registerWaitBlocker } from "../src/manager.js";
import { registerSubagentModule } from "../src/subagent.js";

function setup() {
  const tools: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerMessageRenderer() {},
    getActiveTools: () => ["read", "bash", "subagent"],
  };
  const manager: any = {
    jobs: new Map(),
    generation: 0,
    lifecycle: new AbortController(),
    nextVirtualPid: 1,
    currentCtx: undefined,
    shuttingDown: false,
    guard() {},
    syncStatus() {},
    track: (promise: Promise<void>) => promise,
    trackSetup: () => () => {},
    deliverCompletion() {},
    killJob: () => false,
    currentRecord: () => undefined,
  };
  registerSubagentModule(pi, manager);
  return { tools, manager };
}

test("blocks sleep and polling loops in bash tool calls", async () => {
  const handlers: Array<{ name: string; handler: (event: any) => any }> = [];
  const pi: any = {
    on(name: string, handler: (event: any) => any) {
      handlers.push({ name, handler });
    },
  };
  registerWaitBlocker(pi);
  const toolCall = handlers.find((h) => h.name === "tool_call");
  assert.ok(toolCall);
  const run = (event: any) => toolCall.handler(event);

  assert.equal(
    await run({ toolName: "bash", input: { command: "ls -la" } }),
    undefined,
  );
  assert.equal(
    await run({ toolName: "bash", input: { command: "rg -n sleep src" } }),
    undefined,
  );
  assert.equal(
    await run({ toolName: "bash", input: { command: "timeout 30 npm test" } }),
    undefined,
  );

  for (const command of [
    "sleep 5",
    "sleep 0.1 && subagent status",
    "while true; do sleep 1; done",
    "for i in {1..10}; do sleep 1; done",
  ]) {
    const result = await run({ toolName: "bash", input: { command } });
    assert.equal(result?.block, true, `expected ${command} to be blocked`);
    assert.match(result.reason, /results arrive automatically/);
  }
});

test("registers the subagent tool", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);

  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };
  const status = await subagent.execute(
    "smoke",
    { action: "status", sessionId: "smoke-missing-session" },
    undefined,
    undefined,
    ctx,
  );
  assert.match(status.content[0].text, /No matching subagent sessions/);
});

test("validates subagent parameters", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "spawn", prompt: "" },
        undefined,
        undefined,
        ctx,
      ),
    /prompt is required for spawn/,
  );

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "spawn", prompt: "test", cwd: "./src", worktree: true },
        undefined,
        undefined,
        ctx,
      ),
    /cwd cannot be combined with worktree:true/,
  );

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "stop", sessionId: "missing" },
        undefined,
        undefined,
        ctx,
      ),
    /Running subagent not found/,
  );
});
