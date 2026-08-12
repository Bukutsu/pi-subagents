import assert from "node:assert/strict";
import test from "node:test";
import { registerSubagentModule } from "../src/subagent.js";

function setup() {
  const tools: any[] = [];
  const commands: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) =>
      commands.push({ name, command }),
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
  return { tools, commands, manager };
}

test("registers the subagent tool and slash command", async () => {
  const { tools, commands } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);
  assert.ok(commands.some((command) => command.name === "subagent"));

  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };
  ctx.sessionManager.getLeafId = () => "leaf-1";
  ctx.sessionManager.getBranch = () => [{ id: "leaf-1" }];
  const status = await subagent.execute(
    "smoke",
    { action: "status", sessionId: "smoke-missing-session" },
    undefined,
    undefined,
    ctx,
  );
  assert.deepEqual(JSON.parse(status.content[0].text).sessions, []);
  assert.equal(status.details.displayText, "No matching subagent sessions.");
});

test("queries the live session model scope", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const scopedModels: Array<{
    model: { provider: string; id: string };
    thinkingLevel?: string;
  }> = [
    {
      model: { provider: "provider", id: "one" },
      thinkingLevel: "high",
    },
  ];
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels,
    modelRegistry: {
      getAvailable: () => scopedModels.map((entry) => entry.model),
    },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  const first = await subagent.execute(
    "models-1",
    { action: "models" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    JSON.parse(first.content[0].text).models[0].model,
    "provider/one",
  );

  scopedModels.splice(0, 1, {
    model: { provider: "provider", id: "two" },
  });
  const second = await subagent.execute(
    "models-2",
    { action: "models" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(
    JSON.parse(second.content[0].text).models[0].model,
    "provider/two",
  );
});

test("steer preserves completion mode when omitted", async () => {
  const { tools, manager } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const session = {
    isStreaming: true,
    steer: async () => {},
  };
  const job: any = {
    pid: 1,
    sessionId: "session-steer",
    session,
    completion: "continue",
  };
  manager.jobs.set(1, job);
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  await subagent.execute(
    "steer",
    { action: "steer", sessionId: "session-steer", message: "next" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(job.completion, "continue");
});

test("validates subagent parameters", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const ctx: any = {
    cwd: process.cwd(),
    hasUI: false,
    isIdle: () => true,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };

  ctx.sessionManager.getLeafId = () => "leaf-1";
  ctx.sessionManager.getBranch = () => [{ id: "leaf-1" }];
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
