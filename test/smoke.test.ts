import assert from "node:assert/strict";
import test from "node:test";
import extension from "../index.js";
import {
  registerSubagentModule,
  resolveCompletion,
  shouldForwardApiKey,
} from "../src/subagent.js";

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
    canStart: () => true,
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

test("skips child resource-loader initialization", () => {
  globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ = 1;
  const registered: string[] = [];
  try {
    extension({
      registerTool: () => registered.push("tool"),
      registerCommand: () => registered.push("command"),
    } as any);
    assert.deepEqual(registered, []);
  } finally {
    delete globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__;
  }
});

test("registers the subagent tool and slash command", async () => {
  const { tools, commands } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);
  assert.ok(commands.some((command) => command.name === "subagent"));
  assert.deepEqual(Object.keys(subagent.parameters.properties), [
    "prompt",
    "model",
    "worktree",
    "background",
  ]);
  const modelTool = tools.find((tool) => tool.name === "subagent_models");
  assert.ok(modelTool);

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

test("lists the current model before scoped alternatives", async () => {
  const { tools } = setup();
  const current = {
    provider: "provider",
    id: "current",
    name: "Current",
    reasoning: true,
    contextWindow: 100_000,
    maxTokens: 10_000,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
  const alternative = {
    provider: "provider",
    id: "alternative",
    name: "Alternative",
    reasoning: false,
    contextWindow: 32_000,
    maxTokens: 4_000,
    input: ["text"],
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
  };
  const modelTool = tools.find((tool) => tool.name === "subagent_models");
  const ctx: any = {
    model: current,
    scopedModels: [{ model: alternative }],
    modelRegistry: {
      getAvailable: () => [current, alternative],
    },
  };

  const result = await modelTool.execute(
    "models-current-first",
    {},
    undefined,
    undefined,
    ctx,
  );
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.models[0].model, "provider/current");
  assert.equal(parsed.models[0].current, true);
  assert.equal(parsed.models[1].model, "provider/alternative");
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

test("defaults completion to parent continuation unless background is explicit", () => {
  assert.equal(resolveCompletion(undefined), "continue");
  assert.equal(resolveCompletion(undefined, true), "queue");
  assert.equal(resolveCompletion("queue"), "queue");
  assert.equal(resolveCompletion("continue", true), "continue");
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

  await assert.rejects(
    () =>
      subagent.execute(
        "id",
        { action: "spawn", prompt: "test", context: "fork" },
        undefined,
        undefined,
        ctx,
      ),
    /context:fork is no longer supported/,
  );
});

test("supports extension models in models action and model resolution", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const extensionModels = [
    {
      provider: "antigravity",
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
    },
    { provider: "flm", id: "gemma3:1b", name: "Gemma3 1B" },
  ];
  const mockRuntime: any = {
    getModels: () => extensionModels,
    getAvailableSnapshot: () => extensionModels,
    getAvailable: async () => extensionModels,
    getProvider: () => ({ name: "Extension Provider" }),
  };
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: {
      runtime: mockRuntime,
      getAvailable: () => extensionModels,
      getAll: () => extensionModels,
      getRegisteredProviderIds: () => ["antigravity", "flm"],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => undefined,
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  const modelsResult = await subagent.execute(
    "models-ext",
    { action: "models" },
    undefined,
    undefined,
    ctx,
  );
  const parsed = JSON.parse(modelsResult.content[0].text);
  assert.equal(parsed.total, 2);
  assert.equal(parsed.models[0].model, "antigravity/gemini-3.7-flash");
  assert.equal(parsed.models[1].model, "flm/gemma3:1b");
});

test("refreshes model runtime snapshot after binding extensions", async () => {
  let refreshCalled = false;
  const extensionModels = [
    {
      provider: "antigravity",
      id: "gemini-3.7-flash",
      name: "Gemini 3.7 Flash",
    },
  ];
  const mockRuntime: any = {
    getModels: () => extensionModels,
    getAvailableSnapshot: () => extensionModels,
    getAvailable: async () => extensionModels,
    getProvider: () => ({ name: "Antigravity Provider" }),
    refresh: async () => {
      refreshCalled = true;
    },
  };
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: {
      runtime: mockRuntime,
      getAvailable: () => extensionModels,
      getAll: () => extensionModels,
      getRegisteredProviderIds: () => ["antigravity"],
      getRegisteredNativeProvider: () => undefined,
      getRegisteredProviderConfig: () => ({ name: "Antigravity" }),
      getProvider: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
    },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent);
  await subagent.execute(
    "models-refresh",
    { action: "models" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(refreshCalled, true);
});

test("prepares raw tool call arguments with array tools", () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  assert.ok(subagent.prepareArguments);

  const prepared = subagent.prepareArguments({
    action: "spawn",
    tools: ["read", "bash"],
    prompt: "do work",
  });
  assert.deepEqual(prepared, {
    action: "spawn",
    tools: "read,bash",
    prompt: "do work",
  });
});

test("does not push api-key overrides onto a shared parent runtime or OAuth providers", () => {
  assert.equal(
    shouldForwardApiKey({
      sharingParentRuntime: true,
      parentAuthOk: true,
      hasApiKey: true,
      oauthInUse: false,
    }),
    false,
    "shared runtime must not receive an override: credentials are already exposed",
  );
  assert.equal(
    shouldForwardApiKey({
      sharingParentRuntime: false,
      parentAuthOk: true,
      hasApiKey: true,
      oauthInUse: true,
    }),
    false,
    "OAuth providers must not receive the resolved key as an api_key override",
  );
  assert.equal(
    shouldForwardApiKey({
      sharingParentRuntime: false,
      parentAuthOk: true,
      hasApiKey: false,
      oauthInUse: false,
    }),
    false,
    "no override without a resolved key",
  );
  assert.equal(
    shouldForwardApiKey({
      sharingParentRuntime: false,
      parentAuthOk: true,
      hasApiKey: true,
      oauthInUse: false,
    }),
    true,
    "fresh runtime with an api-key provider forwards the key",
  );
});

test("filters out pi-subagents extension to prevent recursive child loading", () => {
  const baseExtensions: any = {
    extensions: [
      {
        path: "/home/user/.pi/agent/extensions/pi-subagents/index.js",
        resolvedPath: "/home/user/.pi/agent/extensions/pi-subagents/index.js",
        tools: new Map([["subagent", {}]]),
      },
      {
        path: "/home/user/.pi/agent/extensions/custom-tool/index.js",
        resolvedPath: "/home/user/.pi/agent/extensions/custom-tool/index.js",
        tools: new Map([["my_custom_tool", {}]]),
      },
    ],
    errors: [],
    runtime: {},
  };

  const filtered = baseExtensions.extensions.filter(
    (ext: any) =>
      !ext.tools.has("subagent") &&
      !ext.path.includes("pi-subagents") &&
      !ext.resolvedPath.includes("pi-subagents"),
  );

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tools.has("my_custom_tool"), true);
});
