import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import extension from "../index.js";
import {
  registerSubagentModule,
  resolveCompletion,
  shouldForwardApiKey,
} from "../src/subagent.js";
import { validateToolArguments } from "@earendil-works/pi-ai";

function setup() {
  const tools: any[] = [];
  const commands: any[] = [];
  const handlers: Record<string, any> = {};
  const pi: any = {
    registerTool: (tool: any) => tools.push(tool),
    registerCommand: (name: string, command: any) =>
      commands.push({ name, command }),
    registerMessageRenderer() {},
    on: (event: string, handler: any) => (handlers[event] = handler),
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
  return { tools, commands, manager, handlers };
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
  assert.ok(commands.some((command) => command.name === "subagents"));
  assert.ok(commands.some((command) => command.name === "subagent"));
  assert.deepEqual(Object.keys(subagent.parameters.properties), [
    "prompt",
    "model",
    "worktree",
    "background",
    "sessionId",
    "stop",
    "peek",
  ]);

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

test("model hint lists current first, scoped alternatives live", async () => {
  const { handlers } = setup();
  const onBeforeAgentStart = handlers["before_agent_start"];
  assert.ok(onBeforeAgentStart);
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
  // Live getters mirror pi's ExtensionContext: values resolved at call time.
  let scopedModels: Array<{ model: { provider: string; id: string } }> = [];
  const ctx: any = {
    get model() {
      return current;
    },
    get scopedModels() {
      return scopedModels;
    },
    modelRegistry: {
      getAvailable: () => [current, alternative],
    },
  };
  const event: any = { systemPrompt: "base" };

  await onBeforeAgentStart(event, ctx);
  assert.match(
    event.systemPrompt,
    /Subagent models: current = provider\/current/,
  );
  assert.doesNotMatch(event.systemPrompt, /Scoped models:/);

  // /scoped-models changes mid session; the next turn must reflect it.
  // The current model stays listed first even when out of scope (spawn
  // resolution keeps it selectable so omit == passing its ID).
  scopedModels = [{ model: alternative }];
  const secondEvent: any = { systemPrompt: "base" };
  await onBeforeAgentStart(secondEvent, ctx);
  assert.match(
    secondEvent.systemPrompt,
    /Scoped models: provider\/current, provider\/alternative/,
  );
});

test('legacy action:"models" is gone; status still works', async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionId: () => "smoke-session",
      getSessionFile: () => undefined,
    },
  };
  ctx.sessionManager.getLeafId = () => "leaf-1";
  ctx.sessionManager.getBranch = () => [{ id: "leaf-1" }];

  await assert.rejects(() =>
    subagent.execute(
      "models-gone",
      { action: "models" },
      undefined,
      undefined,
      ctx,
    ),
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

test("bare sessionId plus prompt steers a still-running session", async () => {
  const { tools, manager } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const steered: string[] = [];
  const session = {
    isStreaming: true,
    steer: async (text: string) => {
      steered.push(text);
    },
  };
  manager.jobs.set(1, {
    pid: 1,
    sessionId: "session-live",
    session,
    completion: "continue",
  } as any);
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  const result = await subagent.execute(
    "native-steer",
    { sessionId: "session-live", prompt: "wrap it up" },
    undefined,
    undefined,
    ctx,
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.action, "steer");
  assert.equal(payload.queued, true);
  assert.deepEqual(steered, ["wrap it up"]);
});

test("bare sessionId plus prompt on an unknown id falls through to resume", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  // No active job and no durable record: must take the resume path (which
  // reports the missing durable record), not the steer or fresh-spawn path.
  await assert.rejects(
    () =>
      subagent.execute(
        "native-resume",
        { sessionId: "session-gone", prompt: "continue please" },
        undefined,
        undefined,
        ctx,
      ),
    /Subagent session not found/,
  );
});

test("stop and peek require sessionId", async () => {
  const { tools } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");

  // Prompt-less control calls must pass schema validation.
  const validated = validateToolArguments(subagent, {
    type: "toolCall",
    id: "t1",
    name: "subagent",
    arguments: { peek: true, sessionId: "session-x" },
  });
  assert.deepEqual(validated, { peek: true, sessionId: "session-x" });

  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  await assert.rejects(
    () => subagent.execute("s1", { stop: true }, undefined, undefined, ctx),
    /sessionId is required to stop/,
  );
  await assert.rejects(
    () => subagent.execute("p1", { peek: true }, undefined, undefined, ctx),
    /sessionId is required to peek/,
  );
});

test("stop interrupts a running session", async () => {
  const { tools, manager } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const killed: number[] = [];
  manager.killJob = (pid: number) => {
    killed.push(pid);
    return true;
  };
  manager.jobs.set(7, { pid: 7, sessionId: "session-stop" });
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  const result = await subagent.execute(
    "stop-run",
    { sessionId: "session-stop", stop: true },
    undefined,
    undefined,
    ctx,
  );
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.action, "stop");
  assert.equal(payload.state, "stopping");
  assert.deepEqual(killed, [7]);
});

test("peek reports live state and last assistant output", async () => {
  const { tools, manager } = setup();
  const subagent = tools.find((tool) => tool.name === "subagent");
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-peek-"));
  const sessionFile = join(dir, "child.jsonl");
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "hi" }] },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm" },
            { type: "text", text: "PEEK-MARKER done" },
          ],
        },
      }),
    ].join("\n"),
  );
  manager.jobs.set(9, {
    pid: 9,
    sessionId: "session-peek",
    startedAt: Date.now() - 5_000,
    activity: "tool: bash",
    stopping: false,
    record: {
      sessionId: "session-peek",
      sessionFile,
      model: "provider/one",
      turns: 3,
    },
  });
  const ctx: any = {
    cwd: process.cwd(),
    scopedModels: [],
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getLeafId: () => "leaf-1",
      getBranch: () => [{ id: "leaf-1" }],
    },
  };

  try {
    const result = await subagent.execute(
      "peek-run",
      { sessionId: "session-peek", peek: true },
      undefined,
      undefined,
      ctx,
    );
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.action, "peek");
    assert.equal(payload.state, "running");
    assert.equal(payload.activity, "tool: bash");
    assert.equal(payload.model, "provider/one");
    assert.equal(payload.turns, 3);
    assert.match(payload.output, /PEEK-MARKER done/);
    assert.ok(!payload.output.includes("hmm"), "thinking must be excluded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    /prompt is required/,
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

test("hint lists extension-registered models", async () => {
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
    model: extensionModels[0],
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

  const { handlers } = setup();
  const onBeforeAgentStart = handlers["before_agent_start"];
  assert.ok(onBeforeAgentStart);
  const event: any = { systemPrompt: "base" };
  await onBeforeAgentStart(event, ctx);
  assert.match(event.systemPrompt, /antigravity\/gemini-3\.7-flash/);
  assert.match(event.systemPrompt, /flm\/gemma3:1b/);
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

  const { handlers } = setup();
  const onBeforeAgentStart = handlers["before_agent_start"];
  assert.ok(onBeforeAgentStart);
  const event: any = { systemPrompt: "base" };
  await onBeforeAgentStart(event, ctx);
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
