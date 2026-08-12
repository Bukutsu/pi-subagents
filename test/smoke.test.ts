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
