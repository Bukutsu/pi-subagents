import { randomUUID } from "node:crypto";
import {
  existsSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Model,
  StringEnum,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SubagentManager } from "./manager.js";
import {
  getLogDir,
  HISTORIC_SUBAGENT_LOCKS,
  HISTORIC_SUBAGENT_SESSION_DIR,
  LEGACY_SUBAGENT_LOCKS,
  LEGACY_SUBAGENT_SESSION_DIR,
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  SUBAGENT_SESSION_DIR,
  SUBAGENT_WORKTREES,
  retainLog,
  type SubagentJob,
  type SubagentRecord,
  type TerminalState,
} from "./types.js";
import {
  acquireSessionLock,
  extractTextContent,
  getScopedModels,
  isPathInside,
  isPathInsideAny,
  MODEL_OUTPUT_MAX_BYTES,
  MODEL_OUTPUT_MAX_LINES,
  readIndex,
  renderToolResult,
  resolveSubagentCwd,
  sanitizeTerminalOutput,
  sanitizeForkMessages,
  saveRecord,
  serializeModelJson,
  SUBAGENT_SESSION_ROOTS,
  SUBAGENT_WORKTREE_ROOTS,
} from "./utils.js";
import {
  createWorktree,
  getGitBranch,
  getGitCommonDir,
  removeWorktree,
} from "./worktree.js";

const ABORT_GRACE_MS = 5000;
const MAX_FULL_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_LIST_ITEMS = 20;
const MAX_STATUS_TEXT = 160;

function awaitWithoutCancelling<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(new Error("Subagent setup was cancelled"));
  let onAbort: (() => void) | undefined;
  const cancellation = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Subagent setup was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([promise, cancellation]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

/**
 * Whether the parent-resolved api key should be pushed onto the child runtime
 * as a runtime override. A shared runtime already exposes the parent's stored
 * credentials and overrides; forcing the resolved key there would corrupt
 * OAuth resolution (the OAuth-derived key is not a valid api_key credential).
 */
export function shouldForwardApiKey(options: {
  sharingParentRuntime: boolean;
  parentAuthOk: boolean;
  hasApiKey: boolean;
  oauthInUse: boolean;
}): boolean {
  return (
    !options.sharingParentRuntime &&
    options.parentAuthOk &&
    options.hasApiKey &&
    !options.oauthInUse
  );
}

export function registerSubagentModule(
  pi: ExtensionAPI,
  manager: SubagentManager,
) {
  let modelRuntime: Promise<ModelRuntime> | undefined;

  function statusDetails(record: SubagentRecord, job?: SubagentJob) {
    const current = job ? manager.currentRecord(job) : record;
    const {
      ownerPid: _ownerPid,
      sessionFile: _sessionFile,
      cwd: _cwd,
      ...details
    } = current;
    return {
      ...details,
      ...(job?.stopping ? { state: "stopping" as const } : {}),
      ...(job?.activity ? { activity: job.activity } : {}),
      ...(job
        ? { elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) }
        : {}),
    };
  }

  function formatSubagentStatusTable(
    sessions: Array<ReturnType<typeof statusDetails>>,
  ) {
    if (sessions.length === 0) return "No matching subagent sessions.";

    const cards = sessions.map((s) => {
      const icon =
        s.state === "running"
          ? "●"
          : s.state === "stopping"
            ? "◐"
            : s.state === "finished"
              ? "✓"
              : "✖";
      const duration =
        s.elapsedSec !== undefined
          ? `${s.elapsedSec}s`
          : s.durationSec !== undefined
            ? `${s.durationSec}s`
            : undefined;
      const durationStr = duration ? ` | ${duration}` : "";
      const costText = s.usage.cost ? ` | $${s.usage.cost.toFixed(4)}` : "";
      const shortId = s.sessionId.slice(0, 8);
      const activityStr =
        s.activity ??
        `${s.turns} turn${s.turns === 1 ? "" : "s"}, ${s.toolCount} tool${s.toolCount === 1 ? "" : "s"}${s.toolFailures ? `, ${s.toolFailures} failure${s.toolFailures === 1 ? "" : "s"}` : ""}`;

      const thinkingStr = s.thinking
        ? `:${sanitizeTerminalOutput(s.thinking)}`
        : "";
      return `${icon} ${s.state}  ${sanitizeTerminalOutput(s.label)}
  Model: \`${sanitizeTerminalOutput(s.model)}${thinkingStr}\` | Session: \`${sanitizeTerminalOutput(shortId)}\`${durationStr}${costText}
  Activity: ${sanitizeTerminalOutput(activityStr)}`;
    });

    return cards.join("\n\n");
  }

  pi.registerCommand("subagent", {
    description: "List and manage background subagents",
    getArgumentCompletions: (prefix) => {
      const items = [
        {
          value: "kill all",
          label: "kill all",
          description: "Stop all subagents",
        },
        ...Array.from(manager.jobs.values(), (job) => ({
          value: `kill ${job.pid}`,
          label: `kill ${job.pid}`,
          description: job.command,
        })),
      ].filter((item) => item.value.startsWith(prefix));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      manager.currentCtx = ctx;
      const trimmed = args?.trim() ?? "";
      if (/^kill\s+all$/i.test(trimmed)) {
        const stopped = manager.killAllJobs();
        ctx.ui.notify(
          `Stopped ${stopped} subagent${stopped === 1 ? "" : "s"}`,
          "info",
        );
        manager.syncStatus(ctx);
        return;
      }
      const killMatch = trimmed.match(/^kill\s+(\d+)$/i);
      if (killMatch) {
        const pid = Number(killMatch[1]);
        if (manager.killJob(pid)) {
          ctx.ui.notify(`Stopped subagent ${pid}`, "info");
          manager.syncStatus(ctx);
        } else {
          ctx.ui.notify(`No subagent found with ID ${pid}`, "error");
        }
        return;
      }
      if (trimmed.startsWith("kill")) {
        ctx.ui.notify("Usage: /subagent kill <pid>", "error");
        return;
      }
      if (trimmed) {
        ctx.ui.notify(
          `Unknown /subagent command: ${sanitizeTerminalOutput(trimmed)}`,
          "error",
        );
        return;
      }
      if (ctx.hasUI) await manager.manageJobs(ctx);
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Run, inspect, steer, or stop durable background Pi sessions. Query models for the live session scope.",
    promptSnippet: "Delegate durable background work to a subagent.",
    promptGuidelines: [
      "Use subagent for multi-step or isolated work; finish your turn immediately after spawning (or do un-blocked independent work) and NEVER poll action:status or sleep.",
      "Set completion: 'continue' when you need the subagent result to proceed — the framework automatically wakes the parent session when the subagent finishes.",
      "Query subagent action:models before choosing an explicit model when the live session scope may have changed.",
      "Use subagent context:fork only when parent history is needed; narrow tools when practical; use worktree:true for concurrent edits.",
    ],
    prepareArguments(args: unknown) {
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const raw = args as Record<string, unknown>;
        if (Array.isArray(raw.tools)) {
          return {
            ...raw,
            tools: raw.tools.join(","),
          };
        }
      }
      return args as any;
    },
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["spawn", "models", "status", "steer", "stop"] as const, {
          description: "Action (default: spawn)",
        }),
      ),
      prompt: Type.Optional(
        Type.String({ description: "Task for spawn or resume" }),
      ),
      description: Type.Optional(
        Type.String({ description: "Short job label" }),
      ),
      sessionId: Type.Optional(
        Type.String({
          description:
            "Durable session identity to resume, inspect, steer, or stop",
        }),
      ),
      message: Type.Optional(
        Type.String({
          description:
            "Message queued after the running child's current turn (steer only)",
        }),
      ),
      completion: Type.Optional(
        StringEnum(["queue", "continue"] as const, {
          description:
            "queue stores the result without waking an idle parent; use 'continue' to automatically wake the parent session when finished",
        }),
      ),
      modelOffset: Type.Optional(
        Type.Number({
          minimum: 0,
          description: "Offset for action:models pagination",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model override from the live scope; without a scope, any available model may be selected; omitted on new sessions inherits the parent and omitted on resume restores the saved model",
        }),
      ),
      thinking: Type.Optional(
        StringEnum(
          ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const,
          {
            description:
              "Thinking level; omitted on resume to restore the saved level",
          },
        ),
      ),
      tools: Type.Optional(
        Type.String({
          description:
            "Comma-separated tool allowlist; can only narrow the parent's active tools",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description:
            "Existing working directory; cannot be combined with worktree:true",
        }),
      ),
      worktree: Type.Optional(
        Type.Boolean({
          description:
            "Create a unique persistent Git branch/worktree for a new session",
        }),
      ),
      context: Type.Optional(
        StringEnum(["project", "fork"] as const, {
          description:
            "project starts fresh with project resources (default); fork seeds sanitized parent conversation",
        }),
      ),
      timeoutSec: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 2_147_483,
          description: "Timeout in seconds (default: 600)",
        }),
      ),
    }),
    async execute(
      _id,
      {
        action = "spawn",
        prompt,
        description,
        sessionId,
        message,
        completion,
        modelOffset = 0,
        model,
        thinking,
        tools,
        cwd,
        worktree = false,
        context = "project",
        timeoutSec = 600,
      },
      signal,
      _up,
      ctx,
    ) {
      manager.currentCtx = ctx;
      const originLeafId = ctx.sessionManager.getLeafId();
      const configuredScope = [...getScopedModels(ctx)];
      const availableModels = ctx.modelRegistry.getAvailable();
      const availableIds = new Set(
        availableModels.map(
          (candidate) => `${candidate.provider}/${candidate.id}`,
        ),
      );
      const scopeRestricted = configuredScope.length > 0;
      const scopedModels = configuredScope.filter((entry) =>
        availableIds.has(`${entry.model.provider}/${entry.model.id}`),
      );
      const requestedId = sessionId?.trim();
      const durable = readIndex();
      const findBySessionPrefix = <T extends { sessionId?: string }>(
        items: T[],
        id: string,
        what: string,
      ) => {
        const matches = items.filter(
          (item) => item.sessionId === id || item.sessionId?.startsWith(id),
        );
        if (matches.length > 1)
          throw new Error(
            `Ambiguous subagent session prefix '${id}' matches ${matches.length} ${what}; use the full sessionId`,
          );
        return matches[0];
      };
      const findActiveSubagent = (id: string) =>
        findBySessionPrefix(
          Array.from(manager.jobs.values()),
          id,
          "running sessions",
        );
      const findDurableRecord = (id: string) => {
        if (Object.hasOwn(durable, id)) return durable[id];
        return findBySessionPrefix(Object.values(durable), id, "sessions");
      };

      const matching = requestedId
        ? findActiveSubagent(requestedId)
        : undefined;

      // ── setupChildSession: child-session setup for spawn ──
      // Model resolution, tool allowlist, session creation, and extension
      // binding. Divergent orchestration (locks, worktrees, fork/resume,
      // durable records) stays in the spawn path.
      type ChildSetupOptions = {
        cwd: string;
        model?: string;
        thinking?: ThinkingLevel;
        tools?: string;
        sessionManager: SessionManager;
        existing?: boolean; // resume: keep saved model/thinking unless overridden
        savedModel?: string;
        savedThinking?: string;
        checkSetup?: () => void; // spawn: guard against parent session end
        setupSignal?: AbortSignal;
        shutdownHandler?: () => void; // caller controller to abort on ctx.shutdown()
      };
      const setupChildSession = async (opts: ChildSetupOptions) => {
        const { existing = false, checkSetup, shutdownHandler } = opts;
        const parentRuntime = (ctx.modelRegistry as any)?.runtime as
          ModelRuntime | undefined;
        let runtime: ModelRuntime;
        if (parentRuntime) {
          runtime = parentRuntime;
        } else {
          const runtimePromise = (modelRuntime ??= ModelRuntime.create());
          void runtimePromise.catch(() => {
            if (modelRuntime === runtimePromise) modelRuntime = undefined;
          });
          runtime = await awaitWithoutCancelling(
            runtimePromise,
            opts.setupSignal,
          );
        }
        checkSetup?.();
        if (typeof ctx.modelRegistry.getRegisteredProviderIds === "function") {
          for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
            try {
              const native =
                ctx.modelRegistry.getRegisteredNativeProvider?.(providerId);
              const config =
                ctx.modelRegistry.getRegisteredProviderConfig?.(providerId);
              if (
                native &&
                typeof runtime.registerNativeProvider === "function"
              ) {
                runtime.registerNativeProvider(native);
              } else if (
                config &&
                typeof runtime.registerProvider === "function"
              ) {
                runtime.registerProvider(providerId, config);
              } else if (typeof runtime.registerNativeProvider === "function") {
                const provider = ctx.modelRegistry.getProvider?.(providerId);
                if (provider) {
                  runtime.registerNativeProvider(provider);
                }
              }
            } catch (providerError) {
              console.warn(
                `Could not forward provider ${providerId} to subagent runtime:`,
                providerError,
              );
            }
          }
        }
        if (typeof runtime.refresh === "function") {
          try {
            await runtime.refresh({ allowNetwork: false });
          } catch {}
        }
        const modelSpec = opts.model?.trim();
        let resolvedModel: Model<any> | undefined;
        let resolvedThinking: ThinkingLevel | undefined;
        let modelRequestWarning: string | undefined;
        const scopedList = scopedModels;
        const modelCandidates = scopeRestricted
          ? scopedList
          : ctx.modelRegistry
              .getAvailable()
              .map((model) => ({ model, thinkingLevel: undefined }));
        if (modelSpec) {
          if (scopeRestricted && modelCandidates.length === 0)
            throw new Error(
              "No models in the live session scope are currently available; adjust /scoped-models or provider authentication",
            );
          if (modelCandidates.length > 0) {
            const lowerSpec = modelSpec.toLowerCase();
            const exactMatches = modelCandidates.filter(
              (s) =>
                `${s.model.provider}/${s.model.id}`.toLowerCase() ===
                  lowerSpec ||
                (!lowerSpec.includes("/") &&
                  s.model.id.toLowerCase() === lowerSpec),
            );
            if (exactMatches.length > 1) {
              throw new Error(
                `Ambiguous model '${modelSpec}'. Matches: ${exactMatches.map((s) => `${s.model.provider}/${s.model.id}`).join(", ")}`,
              );
            }
            const matches = modelCandidates.filter(
              (s) =>
                s.model.id.toLowerCase().includes(lowerSpec) ||
                (s.model.name &&
                  String(s.model.name).toLowerCase().includes(lowerSpec)) ||
                s.model.provider.toLowerCase().includes(lowerSpec),
            );
            let matched = exactMatches[0];
            if (!matched && matches.length === 1) {
              matched = matches[0];
            } else if (!matched && matches.length > 1) {
              throw new Error(
                `Ambiguous model '${modelSpec}'. Matches: ${matches.map((s) => `${s.model.provider}/${s.model.id}`).join(", ")}`,
              );
            }
            if (matched) {
              resolvedModel = matched.model;
              // ScopedModel.thinkingLevel is typed from pi-agent-core; the
              // literal union is identical to pi-ai's ThinkingLevel.
              resolvedThinking = matched.thinkingLevel as
                ThinkingLevel | undefined;
            } else {
              const availableNames = modelCandidates
                .map((s) => `${s.model.provider}/${s.model.id}`)
                .join(", ");
              throw new Error(
                scopeRestricted
                  ? `Model '${modelSpec}' is outside the live session scope. Query subagent action:models and retry. Scope: ${availableNames}`
                  : `Model '${modelSpec}' is unavailable. Query subagent action:models or omit model to inherit the parent`,
              );
            }
          } else {
            throw new Error(
              `Model '${modelSpec}' is unavailable; omit model to inherit the parent`,
            );
          }
        }
        if (!modelSpec && existing && scopeRestricted) {
          if (!scopedList.length)
            throw new Error(
              "No models in the live session scope are currently available; adjust /scoped-models or provider authentication",
            );
          const savedInScope = scopedList.find(
            (entry) =>
              `${entry.model.provider}/${entry.model.id}` === opts.savedModel,
          );
          if (!savedInScope) {
            const fallback =
              scopedList.find(
                (entry) =>
                  entry.model.provider === ctx.model?.provider &&
                  entry.model.id === ctx.model?.id,
              ) ?? scopedList[0];
            resolvedModel = fallback.model;
            resolvedThinking = fallback.thinkingLevel as
              ThinkingLevel | undefined;
            modelRequestWarning = `Saved model ${opts.savedModel ?? "unknown"} left the live scope; resumed with ${fallback.model.provider}/${fallback.model.id}`;
          }
        }
        const parentTools = pi.getActiveTools();
        const requestedTools = opts.tools
          ?.split(",")
          .map((tool) => tool.trim())
          .filter(Boolean);
        const unknownTools =
          requestedTools?.filter((tool) => !parentTools.includes(tool)) ?? [];
        if (unknownTools.length)
          throw new Error(
            `Tools are not active in the parent session: ${unknownTools.join(", ")}`,
          );
        const explicitTools = requestedTools?.length
          ? requestedTools
          : undefined;
        const temporaryExtensionPaths = [
          ...new Set(
            pi
              .getAllTools()
              .filter(
                (tool) =>
                  tool.sourceInfo.scope === "temporary" &&
                  !tool.sourceInfo.path.startsWith("<"),
              )
              .map((tool) => tool.sourceInfo.path),
          ),
        ];
        const requestedThinking = opts.thinking ?? resolvedThinking;
        const scopedEntry =
          !resolvedModel && !existing
            ? (scopedList?.find(
                (s) =>
                  s.model.id === ctx.model?.id &&
                  s.model.provider === ctx.model?.provider,
              ) ?? scopedList?.[0])
            : undefined;
        const savedEntry =
          existing && !resolvedModel && opts.savedModel
            ? modelCandidates.find(
                (entry) =>
                  `${entry.model.provider}/${entry.model.id}` ===
                  opts.savedModel,
              )
            : undefined;
        if (
          existing &&
          !resolvedModel &&
          opts.savedModel &&
          !savedEntry &&
          !scopeRestricted &&
          ctx.model
        ) {
          modelRequestWarning = `Saved model ${opts.savedModel} is unavailable; resumed with ${ctx.model.provider}/${ctx.model.id}`;
        }
        const selectedModel =
          resolvedModel ??
          (!existing
            ? (scopedEntry?.model ?? ctx.model)
            : (savedEntry?.model ?? ctx.model));
        const effectiveThinking =
          requestedThinking ??
          (!existing
            ? (scopedEntry?.thinkingLevel ?? ctx.thinkingLevel)
            : undefined);
        if (selectedModel) {
          const sharingParentRuntime = runtime === parentRuntime;
          // A shared runtime already exposes the parent's credentials (stored
          // OAuth refresh tokens, api-key overrides, env) — forcing the
          // resolved api key as a runtime override there would corrupt OAuth
          // resolution. Only a fresh fallback runtime needs the override, and
          // only for providers not authenticated via OAuth.
          const parentAuth =
            !sharingParentRuntime &&
            typeof ctx.modelRegistry.getApiKeyAndHeaders === "function"
              ? await ctx.modelRegistry.getApiKeyAndHeaders(selectedModel)
              : undefined;
          checkSetup?.();
          const oauthInUse =
            typeof runtime.isUsingOAuth === "function" &&
            runtime.isUsingOAuth(selectedModel.provider);
          if (
            parentAuth?.ok === true &&
            parentAuth.apiKey &&
            shouldForwardApiKey({
              sharingParentRuntime,
              parentAuthOk: true,
              hasApiKey: true,
              oauthInUse,
            }) &&
            typeof runtime.setRuntimeApiKey === "function"
          ) {
            await runtime.setRuntimeApiKey(
              selectedModel.provider,
              parentAuth.apiKey,
              {
                signal: opts.setupSignal,
                ...(parentAuth.env ? { env: parentAuth.env } : {}),
              },
            );
            checkSetup?.();
          }
          if (
            typeof ctx.modelRegistry.getProvider === "function" &&
            typeof runtime.registerNativeProvider === "function"
          ) {
            const provider = ctx.modelRegistry.getProvider(
              selectedModel.provider,
            );
            if (
              provider &&
              typeof runtime.getProvider === "function" &&
              !runtime.getProvider(selectedModel.provider)
            ) {
              try {
                runtime.registerNativeProvider(provider);
              } catch {}
            }
          }
          let childAvailable: readonly Model<any>[] = [];
          if (typeof runtime.getAvailable === "function") {
            try {
              childAvailable = await runtime.getAvailable(
                selectedModel.provider,
                { signal: opts.setupSignal },
              );
              checkSetup?.();
            } catch {}
          }
          const isAvailableInRuntime = childAvailable.some(
            (candidate) =>
              candidate.provider === selectedModel.provider &&
              candidate.id === selectedModel.id,
          );
          const isAvailableInRegistry = ctx.modelRegistry
            .getAvailable()
            .some(
              (candidate) =>
                candidate.provider === selectedModel.provider &&
                candidate.id === selectedModel.id,
            );
          if (!isAvailableInRuntime && !isAvailableInRegistry)
            throw new Error(
              `Model ${selectedModel.provider}/${selectedModel.id} is not available to the child runtime`,
            );
        }
        checkSetup?.();
        const trusted = ctx.isProjectTrusted();
        const settingsManager = SettingsManager.create(opts.cwd, undefined, {
          // Children only load project resources when the parent already
          // trusted this checkout; never by default.
          projectTrusted: trusted,
        });
        let resourceLoader: DefaultResourceLoader | undefined;
        if (!trusted) {
          // Untrusted children must not inherit project instructions
          // (AGENTS.md / CLAUDE.md); keep the user's global context file.
          const agentDir = getAgentDir();
          resourceLoader = new DefaultResourceLoader({
            cwd: opts.cwd,
            agentDir,
            settingsManager,
            ...(temporaryExtensionPaths.length
              ? { additionalExtensionPaths: temporaryExtensionPaths }
              : {}),
            agentsFilesOverride: (base) => ({
              agentsFiles: base.agentsFiles.filter((f) =>
                f.path.startsWith(agentDir + sep),
              ),
            }),
          });
          // Global extensions remain available for tools, but cannot inject
          // project skills, prompts, or themes into an untrusted child.
          resourceLoader.extendResources = () => {};
          await resourceLoader.reload();
          checkSetup?.();
        } else if (temporaryExtensionPaths.length) {
          resourceLoader = new DefaultResourceLoader({
            cwd: opts.cwd,
            agentDir: getAgentDir(),
            settingsManager,
            additionalExtensionPaths: temporaryExtensionPaths,
          });
          await resourceLoader.reload();
          checkSetup?.();
        }
        const setupController = new AbortController();
        let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
        try {
          created = await createAgentSession({
            cwd: opts.cwd,
            modelRuntime: runtime,
            sessionManager: opts.sessionManager,
            settingsManager,
            ...(resourceLoader ? { resourceLoader } : {}),
            ...(explicitTools ? { tools: explicitTools } : {}),
            ...(selectedModel ? { model: selectedModel } : {}),
            ...(!existing
              ? { thinkingLevel: effectiveThinking as ThinkingLevel }
              : requestedThinking
                ? { thinkingLevel: requestedThinking as ThinkingLevel }
                : {}),
          });
          checkSetup?.();
        } catch (error) {
          if (created) {
            try {
              await created.session.dispose();
            } catch {}
          }
          throw error;
        }
        const session = created.session;
        const initializedModel = session.model;
        if (!initializedModel) {
          try {
            await session.dispose();
          } catch {}
          throw new Error("Subagent session did not initialize a model");
        }
        let disposed = false;
        let forceDisposed = false;
        const forceDispose = () => {
          if (forceDisposed) return;
          forceDisposed = true;
          try {
            session.dispose();
          } catch {}
        };
        const dispose = async () => {
          if (disposed) return;
          disposed = true;
          if (!forceDisposed) {
            let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              let timedOut = false;
              await Promise.race([
                session.extensionRunner.emit({
                  type: "session_shutdown",
                  reason: "quit",
                }),
                new Promise<void>((resolve) => {
                  shutdownTimer = setTimeout(() => {
                    timedOut = true;
                    resolve();
                  }, 5000);
                  shutdownTimer.unref();
                }),
              ]);
              if (timedOut)
                console.warn(
                  `Timed out while shutting down subagent ${session.sessionId}`,
                );
            } catch {
            } finally {
              if (shutdownTimer) clearTimeout(shutdownTimer);
            }
          }
          forceDispose();
        };
        const abortSetup = forceDispose;
        if (opts.setupSignal?.aborted) abortSetup();
        else
          opts.setupSignal?.addEventListener("abort", abortSetup, {
            once: true,
          });
        try {
          checkSetup?.();
          if (existing && resolvedModel) {
            opts.sessionManager.appendModelChange(
              initializedModel.provider,
              initializedModel.id,
            );
          }
          if (
            existing &&
            (opts.thinking !== undefined || resolvedThinking !== undefined) &&
            session.thinkingLevel !== opts.savedThinking
          ) {
            opts.sessionManager.appendThinkingLevelChange(
              session.thinkingLevel,
            );
          }
          if (
            existing &&
            scopeRestricted &&
            !scopedModels.some(
              (entry) =>
                entry.model.provider === initializedModel.provider &&
                entry.model.id === initializedModel.id,
            )
          ) {
            throw new Error(
              `Saved subagent model ${initializedModel.provider}/${initializedModel.id} is not in the active model scope`,
            );
          }
          await session.bindExtensions({
            mode: "print",
            abortHandler: () => void session.abort(),
            shutdownHandler: () => {
              setupController.abort();
              shutdownHandler?.();
            },
            onError: (error) =>
              console.warn(`Subagent extension error: ${error.error}`),
          });
          checkSetup?.();
          if (typeof (session as any)._modelRuntime?.refresh === "function") {
            try {
              await (session as any)._modelRuntime.refresh({
                allowNetwork: false,
              });
            } catch {}
          } else if (typeof runtime.refresh === "function") {
            try {
              await runtime.refresh({ allowNetwork: false });
            } catch {}
          }
          if (setupController.signal.aborted)
            throw new Error(
              "Subagent extension requested shutdown during setup",
            );
          for (const error of created.extensionsResult.errors)
            console.warn(
              `Subagent extension failed to load ${error.path}: ${error.error}`,
            );
        } catch (error) {
          await dispose();
          throw error;
        } finally {
          opts.setupSignal?.removeEventListener("abort", abortSetup);
        }
        let actualTools = session.getActiveToolNames();
        let toolInheritanceWarning: string | undefined;
        if (explicitTools) {
          const missingTools = explicitTools.filter(
            (name) => !actualTools.includes(name),
          );
          const unexpectedTools = actualTools.filter(
            (name) => !explicitTools.includes(name),
          );
          if (missingTools.length || unexpectedTools.length) {
            await dispose();
            throw new Error(
              [
                missingTools.length
                  ? `Requested parent tools were not available in the child: ${missingTools.join(", ")}`
                  : "",
                unexpectedTools.length
                  ? `Child enabled unexpected tools: ${unexpectedTools.join(", ")}`
                  : "",
              ]
                .filter(Boolean)
                .join("; "),
            );
          }
        } else {
          const unavailableTools = parentTools.filter(
            (name) => !actualTools.includes(name),
          );
          const inheritedTools = parentTools.filter(
            (name) => name !== "subagent" && actualTools.includes(name),
          );
          session.setActiveToolsByName(inheritedTools);
          actualTools = session.getActiveToolNames();
          if (unavailableTools.length)
            toolInheritanceWarning = `Child tools unavailable and omitted: ${unavailableTools.join(", ")}`;
        }
        const modelFallbackMessage = [
          modelRequestWarning,
          created.modelFallbackMessage,
        ]
          .filter((message): message is string => Boolean(message))
          .join("\n");
        return {
          session,
          modelFallbackMessage: modelFallbackMessage || undefined,
          toolInheritanceWarning,
          actualTools,
          dispose,
          forceDispose,
        };
      };

      if (action === "models") {
        const unrestricted = !scopeRestricted;
        const allModels = (
          unrestricted
            ? availableModels.map((model) => ({ model }))
            : scopedModels
        ).map((entry) => ({
          model: `${entry.model.provider}/${entry.model.id}`,
          ...("thinkingLevel" in entry && entry.thinkingLevel
            ? { thinking: entry.thinkingLevel as ThinkingLevel }
            : {}),
        }));
        const models = allModels.slice(
          modelOffset,
          modelOffset + MAX_LIST_ITEMS,
        );
        const nextOffset =
          modelOffset + models.length < allModels.length
            ? modelOffset + models.length
            : undefined;
        const display = `${unrestricted ? "Available subagent models (scope unrestricted)" : "Available scoped subagent models"}:\n${models
          .map(
            (entry) =>
              `- ${entry.model}${entry.thinking ? `:${entry.thinking}` : ""}`,
          )
          .join("\n")}`;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                v: 1,
                type: "subagent",
                action: "models",
                scope: unrestricted ? "unrestricted" : "restricted",
                models,
                ...(nextOffset !== undefined ? { nextOffset } : {}),
                total: allModels.length,
              }),
            },
          ],
          details: {
            models,
            unrestricted,
            nextOffset,
            total: allModels.length,
            displayText: display,
          },
        };
      }
      if (action === "status") {
        const active = new Map(
          Array.from(manager.jobs.values()).map((job) => [job.sessionId, job]),
        );
        const durableRecord = requestedId
          ? findDurableRecord(requestedId)
          : undefined;
        const records = requestedId
          ? matching?.record
            ? [matching.record]
            : durableRecord
              ? [durableRecord]
              : []
          : [
              ...Array.from(active.values(), (job) => job.record!).slice(
                0,
                MAX_LIST_ITEMS,
              ),
              ...Object.values(durable)
                .filter((record) => !active.has(record.sessionId))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5),
            ];
        const sessions = records.map((record) =>
          statusDetails(record, active.get(record.sessionId)),
        );
        const text = formatSubagentStatusTable(sessions);
        const compactSessions = sessions.map((session) => ({
          sessionId: session.sessionId,
          state: session.state,
          label: session.label.slice(0, MAX_STATUS_TEXT),
          model: session.model.slice(0, MAX_STATUS_TEXT),
          ...(session.thinking ? { thinking: session.thinking } : {}),
          ...(session.elapsedSec !== undefined
            ? { elapsedSec: session.elapsedSec }
            : {}),
          ...(session.durationSec !== undefined
            ? { durationSec: session.durationSec }
            : {}),
          ...(session.activity
            ? { activity: session.activity.slice(0, MAX_STATUS_TEXT) }
            : {}),
          turns: session.turns,
          toolCount: session.toolCount,
          toolFailures: session.toolFailures,
          ...(session.usage.cost ? { cost: session.usage.cost } : {}),
        }));
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                v: 1,
                type: "subagent",
                action: "status",
                sessions: compactSessions,
              }),
            },
          ],
          details: { sessions, displayText: text },
        };
      }
      if (action === "stop") {
        if (!matching)
          throw new Error(
            `Running subagent not found: ${requestedId || "missing sessionId"}`,
          );
        manager.killJob(matching.pid);
        manager.syncStatus(ctx);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                v: 1,
                type: "subagent",
                action: "stop",
                sessionId: matching.sessionId,
                state: "stopping",
              }),
            },
          ],
          details: {
            sessionId: matching.sessionId,
            state: "stopping",
            displayText: `Stopping subagent ${matching.sessionId}`,
          },
        };
      }
      if (action === "steer") {
        if (!matching?.session)
          throw new Error(
            `Running subagent not found: ${requestedId || "missing sessionId"}`,
          );
        if (matching.handedOff)
          throw new Error(
            `Subagent ${matching.sessionId} is finishing after a session reload; steer it after its result arrives`,
          );
        if (!message?.trim()) throw new Error("message is required for steer");
        // session.steer() only queues while the agent is streaming; reject
        // instead of silently losing guidance to a completion race.
        if (!matching.session.isStreaming)
          throw new Error(
            `Subagent ${matching.sessionId} is not currently running`,
          );
        try {
          await matching.session.steer(message.trim());
          if (completion !== undefined) matching.completion = completion;
        } catch (error) {
          if (!manager.jobs.has(matching.pid))
            throw new Error(`Subagent ${matching.sessionId} already finished`);
          throw error;
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                v: 1,
                type: "subagent",
                action: "steer",
                sessionId: matching.sessionId,
                queued: true,
              }),
            },
          ],
          details: {
            sessionId: matching.sessionId,
            queued: true,
            displayText: `Queued steering for subagent ${matching.sessionId}`,
          },
        };
      }
      if (!prompt?.trim()) throw new Error("prompt is required for spawn");
      completion ??= "queue";
      const expectedGeneration = manager.generation;
      manager.guard(expectedGeneration);
      const setupController = new AbortController();
      const setupSignal = AbortSignal.any([
        ...(signal ? [signal] : []),
        manager.lifecycle.signal,
        setupController.signal,
      ]);
      const checkSetup = () => {
        manager.guard(expectedGeneration);
        if (setupSignal.aborted)
          throw new Error("Subagent setup was cancelled");
      };
      prompt = prompt.trim();
      if (requestedId && matching)
        throw new Error(`Subagent session ${requestedId} is already running`);
      if (worktree && cwd !== undefined)
        throw new Error("cwd cannot be combined with worktree:true");
      if (requestedId && worktree)
        throw new Error(
          "worktree:true is only valid for a new subagent session",
        );
      if (requestedId && context === "fork")
        throw new Error(
          "context:fork is only valid for a new subagent session",
        );
      const releaseSetup = manager.trackSetup(setupController);
      let setupReleased = false;
      const releaseTrackedSetup = () => {
        if (!setupReleased) {
          setupReleased = true;
          releaseSetup();
        }
      };
      if (context === "fork") {
        checkSetup();
      }
      let finishSetup!: () => void;
      manager.track(
        new Promise<void>((resolve) => {
          finishSetup = () => {
            releaseTrackedSetup();
            resolve();
          };
        }),
      );
      let existing: SubagentRecord | undefined;
      let validatedSessionFile: string | undefined;
      let validatedCwd: string | undefined;
      try {
        existing = requestedId ? findDurableRecord(requestedId) : undefined;
        if (requestedId && !existing)
          throw new Error(
            `Subagent session not found in ${SUBAGENT_INDEX}: ${requestedId}`,
          );
        if (
          existing &&
          (!existsSync(existing.cwd) || !statSync(existing.cwd).isDirectory())
        ) {
          throw new Error(
            `Cannot resume subagent ${requestedId}: saved cwd${existing.branch ? "/worktree" : ""} is missing or deleted: ${existing.cwd}`,
          );
        }
        if (existing) {
          // Only resume from paths this extension controls: the session file
          // must be a regular file inside the pi-subagents session
          // dir, and the cwd inside the parent project or a
          // pi-subagents worktree. A tampered index
          // must not redirect the child elsewhere.
          let sessionFileReal = "";
          try {
            sessionFileReal = realpathSync(existing.sessionFile);
          } catch {}
          if (
            !sessionFileReal ||
            !isPathInsideAny(SUBAGENT_SESSION_ROOTS, sessionFileReal) ||
            !statSync(sessionFileReal).isFile()
          ) {
            throw new Error(
              `Cannot resume subagent ${requestedId}: session file is not a regular file inside ${SUBAGENT_SESSION_DIR}: ${existing.sessionFile}`,
            );
          }
          validatedSessionFile = sessionFileReal;
          if (existing.branch) {
            if (!isPathInsideAny(SUBAGENT_WORKTREE_ROOTS, existing.cwd)) {
              throw new Error(
                `Cannot resume subagent ${requestedId}: worktree cwd is outside ${SUBAGENT_WORKTREES}: ${existing.cwd}`,
              );
            }
            validatedCwd = realpathSync(existing.cwd);
            const [parentGitDir, worktreeGitDir] = await Promise.all([
              getGitCommonDir(pi, ctx.cwd, setupSignal),
              getGitCommonDir(pi, validatedCwd, setupSignal),
            ]);
            if (!parentGitDir || parentGitDir !== worktreeGitDir) {
              throw new Error(
                `Cannot resume subagent ${requestedId}: worktree belongs to a different Git repository`,
              );
            }
            const worktreeBranch = await getGitBranch(
              pi,
              validatedCwd,
              setupSignal,
            );
            if (worktreeBranch !== existing.branch) {
              throw new Error(
                `Cannot resume subagent ${requestedId}: worktree is not on branch ${existing.branch}`,
              );
            }
          } else {
            const resolvedCwd = resolveSubagentCwd(ctx.cwd, existing.cwd);
            if (resolvedCwd !== existing.cwd)
              throw new Error(
                `Cannot resume subagent ${requestedId}: saved cwd is outside the parent project: ${existing.cwd}`,
              );
            validatedCwd = resolvedCwd;
          }
        }
      } catch (error) {
        finishSetup();
        throw error;
      }

      let branch: string | undefined;
      let childCwd: string;
      let isNewWorktree = false;
      try {
        if (existing) {
          childCwd = validatedCwd ?? existing.cwd;
          if (cwd) {
            const resolvedCwd = resolveSubagentCwd(ctx.cwd, cwd);
            if (resolvedCwd !== childCwd) {
              throw new Error(
                `cwd does not match the saved subagent cwd: ${childCwd}`,
              );
            }
          }
          branch = existing.branch;
        } else if (worktree) {
          const created = await createWorktree(pi, ctx, setupSignal);
          childCwd = created.path;
          branch = created.branch;
          isNewWorktree = true;
        } else {
          childCwd = resolveSubagentCwd(ctx.cwd, cwd);
        }
      } catch (error) {
        finishSetup();
        throw error;
      }

      let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
      let modelFallbackMessage: string | undefined;
      let toolInheritanceWarning: string | undefined;
      let sessionFile: string;
      let sessionLock: string;
      let controller = new AbortController();
      let actualTools: string[];
      let disposeChild: () => Promise<void> = async () => {};
      let forceDisposeChild: () => void = () => {};
      let forceCleanupChild: () => void = () => {};
      let sessionManager!: SessionManager;
      // Fresh sessions that fail before registration would leave an
      // unindexed session file; remove it so nothing orphaned accumulates.
      const removeFreshSessionFile = () => {
        if (!existing) {
          try {
            rmSync(sessionManager?.getSessionFile() ?? "", { force: true });
          } catch {}
        }
      };

      try {
        checkSetup();
        const removeLock = () => {
          if (!sessionLock) return;
          const target = sessionLock;
          sessionLock = "";
          try {
            rmSync(target, { recursive: true, force: true });
          } catch {}
        };
        forceCleanupChild = () => {
          try {
            forceDisposeChild();
          } finally {
            removeLock();
          }
        };
        try {
          if (existing) {
            const lockDir = validatedSessionFile
              ? isPathInside(
                  HISTORIC_SUBAGENT_SESSION_DIR,
                  validatedSessionFile,
                )
                ? HISTORIC_SUBAGENT_LOCKS
                : isPathInside(
                      LEGACY_SUBAGENT_SESSION_DIR,
                      validatedSessionFile,
                    )
                  ? LEGACY_SUBAGENT_LOCKS
                  : SUBAGENT_LOCKS
              : SUBAGENT_LOCKS;
            sessionLock = acquireSessionLock(existing.sessionId, lockDir);
          }
          sessionManager = existing
            ? SessionManager.open(
                validatedSessionFile ?? existing.sessionFile,
                isPathInside(
                  HISTORIC_SUBAGENT_SESSION_DIR,
                  validatedSessionFile ?? "",
                )
                  ? HISTORIC_SUBAGENT_SESSION_DIR
                  : isPathInside(
                        LEGACY_SUBAGENT_SESSION_DIR,
                        validatedSessionFile ?? "",
                      )
                    ? LEGACY_SUBAGENT_SESSION_DIR
                    : SUBAGENT_SESSION_DIR,
                childCwd,
              )
            : SessionManager.create(
                childCwd,
                SUBAGENT_SESSION_DIR,
                context === "fork"
                  ? { parentSession: ctx.sessionManager.getSessionFile() }
                  : undefined,
              );
          if (!existing && context === "fork")
            for (const parentMessage of sanitizeForkMessages(ctx))
              sessionManager.appendMessage(parentMessage as any);
          const actualSessionId = sessionManager.getSessionId();
          if (existing && actualSessionId !== existing.sessionId) {
            throw new Error(
              `Cannot resume subagent ${existing.sessionId}: session file contains ${actualSessionId}`,
            );
          }
          if (!existing) sessionLock = acquireSessionLock(actualSessionId);
        } catch (error) {
          removeLock();
          removeFreshSessionFile();
          throw error;
        }
        let prepared: Awaited<ReturnType<typeof setupChildSession>> | undefined;
        try {
          const savedContext = existing
            ? sessionManager.buildSessionContext()
            : undefined;
          prepared = await setupChildSession({
            cwd: childCwd,
            model,
            thinking: thinking as ThinkingLevel | undefined,
            tools,
            sessionManager,
            existing: Boolean(existing),
            savedModel: savedContext?.model
              ? `${savedContext.model.provider}/${savedContext.model.modelId}`
              : existing?.model,
            savedThinking: savedContext?.thinkingLevel,
            checkSetup,
            setupSignal,
            shutdownHandler: () => controller.abort(),
          });
          checkSetup();
        } catch (error) {
          // A post-setup guard can fail after the child has been returned.
          prepared?.forceDispose();
          // setupChildSession disposes anything it created; free the lock and
          // any fresh session file here
          removeLock();
          removeFreshSessionFile();
          throw error;
        }
        if (!prepared)
          throw new Error("Child session setup returned no session");
        session = prepared.session;
        modelFallbackMessage = prepared.modelFallbackMessage;
        toolInheritanceWarning = prepared.toolInheritanceWarning;
        actualTools = prepared.actualTools;
        forceDisposeChild = prepared.forceDispose;
        disposeChild = async () => {
          try {
            await prepared.dispose();
          } finally {
            removeLock();
          }
        };
        if (!session.model) {
          await disposeChild();
          removeFreshSessionFile();
          throw new Error("Subagent session did not initialize a model");
        }
        try {
          if (!existing) {
            sessionManager.appendCustomEntry("pi-subagents", {
              createdAt: new Date().toISOString(),
            });
            if (context === "fork")
              sessionManager.appendModelChange(
                session.model.provider,
                session.model.id,
              );
          }
        } catch (error) {
          await disposeChild();
          removeFreshSessionFile();
          throw error;
        }
        sessionFile =
          session.sessionFile ?? sessionManager.getSessionFile() ?? "";
        if (!sessionFile) {
          await disposeChild();
          removeFreshSessionFile();
          throw new Error(
            "Subagent session did not initialize a persistent session path",
          );
        }
      } catch (setupError) {
        if (isNewWorktree) {
          await removeWorktree(pi, ctx.cwd, childCwd, branch);
        }
        finishSetup();
        throw setupError;
      }

      const pid = manager.getNextPid();
      manager.nextVirtualPid = pid + 1;
      const completionId = randomUUID();
      let timedOut = false;
      let cancelled = false;
      let lastAssistantMessage: AssistantMessage | undefined;
      const activeTools = new Map<string, string>();
      if (controller.signal.aborted) {
        cancelled = true; // timeout timer not started yet
        void session.abort().catch(() => {});
      } else {
        controller.signal.addEventListener(
          "abort",
          () => {
            cancelled = !timedOut;
            void session.abort().catch(() => {});
          },
          { once: true },
        );
      }
      const label = sanitizeTerminalOutput(
        description?.trim() ||
          (prompt.length > 30 ? `${prompt.slice(0, 30)}...` : prompt),
      );
      const displayModel = `${session.model.provider}/${session.model.id}`;
      const fallback = [
        modelFallbackMessage ? `\nModel fallback: ${modelFallbackMessage}` : "",
        toolInheritanceWarning
          ? `\nTool inheritance: ${toolInheritanceWarning}`
          : "",
      ]
        .filter(Boolean)
        .join("");
      const now = new Date().toISOString();
      const record: SubagentRecord = {
        sessionId: session.sessionId,
        cwd: childCwd,
        sessionFile,
        model: displayModel,
        thinking: session.thinkingLevel,
        label,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        state: "running",
        turns: 0,
        toolCount: 0,
        toolFailures: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
          cost: 0,
        },
        inheritedTools: actualTools,
        branch,
        context: existing?.context ?? context,
        ownerPid: process.pid,
      };
      let job!: SubagentJob;
      try {
        job = {
          pid,
          command: `Subagent: ${label}`,
          startedAt: Date.now(),
          sessionId: session.sessionId,
          controller,
          completionId,
          forceCleanup: forceCleanupChild,
          session,
          activity: "starting",
          completion,
          baseline: session.getSessionStats(),
          record,
          toolFailures: 0,
          originLeafId,
          expectedGeneration,
          originSessionFile: ctx.sessionManager.getSessionFile() ?? "",
          originSessionId: ctx.sessionManager.getSessionId(),
        };
        manager.jobs.set(pid, job);
        saveRecord(record);
        checkSetup();
        finishSetup();
      } catch (error) {
        try {
          await disposeChild();
        } catch {}
        manager.jobs.delete(pid);
        removeFreshSessionFile();
        if (isNewWorktree) {
          await removeWorktree(pi, ctx.cwd, childCwd, branch);
        }
        finishSetup();
        throw error;
      }

      const TOOL_ACTIVITY_HOLD_MS = 400;
      let activityTimer: ReturnType<typeof setTimeout> | undefined;
      let pendingActivity: string | undefined;
      const setActivity = (activity: string) => {
        // Fast tools otherwise disappear between two widget refreshes. Keep
        // the last tool visible briefly before returning to the generic state.
        if (activity === "thinking" && job.activity?.startsWith("tool:")) {
          pendingActivity = activity;
          if (!activityTimer) {
            activityTimer = setTimeout(() => {
              activityTimer = undefined;
              const next = pendingActivity;
              pendingActivity = undefined;
              if (next && job.activity !== next) {
                job.activity = next;
                manager.syncStatus(ctx);
              }
            }, TOOL_ACTIVITY_HOLD_MS);
          }
          return;
        }
        pendingActivity = undefined;
        if (activityTimer) {
          clearTimeout(activityTimer);
          activityTimer = undefined;
        }
        if (job.activity === activity) return;
        job.activity = activity;
        manager.syncStatus(ctx);
      };
      const unsubscribe = session.subscribe((event) => {
        if (
          (event.type === "message_update" || event.type === "message_end") &&
          event.message.role === "assistant"
        ) {
          lastAssistantMessage = event.message;
        }
        if (event.type === "turn_start") setActivity("thinking");
        else if (
          event.type === "message_update" &&
          event.assistantMessageEvent?.type === "text_delta" &&
          !activeTools.size
        )
          setActivity("responding");
        else if (event.type === "tool_execution_start") {
          activeTools.set(event.toolCallId, event.toolName);
          setActivity(`tool: ${[...activeTools.values()].join(", ")}`);
        } else if (event.type === "tool_execution_end") {
          activeTools.delete(event.toolCallId);
          if (event.isError) job.toolFailures!++;
          setActivity(
            activeTools.size
              ? `tool: ${[...activeTools.values()].join(", ")}`
              : event.isError
                ? `tool failed: ${event.toolName}`
                : "thinking",
          );
        }
      });
      manager.syncStatus(ctx);
      const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
          timedOut = true;
          controller.abort();
        }
      }, timeoutSec * 1000);
      const done = (async () => {
        try {
          let thrown: string | undefined;
          let forcedStop = false;
          const promptDone = Promise.resolve()
            .then(() => session.prompt(prompt))
            .catch((error) => {
              thrown = error instanceof Error ? error.message : String(error);
            });
          let abortGraceTimer: ReturnType<typeof setTimeout> | undefined;
          let abortListener: (() => void) | undefined;
          const forcedStopDone = new Promise<void>((resolve) => {
            abortListener = () => {
              abortGraceTimer = setTimeout(() => {
                forcedStop = true;
                resolve();
              }, ABORT_GRACE_MS);
              abortGraceTimer.unref();
            };
            if (controller.signal.aborted) abortListener();
            else
              controller.signal.addEventListener("abort", abortListener, {
                once: true,
              });
          });
          try {
            await Promise.race([promptDone, forcedStopDone]);
          } finally {
            if (abortListener)
              controller.signal.removeEventListener("abort", abortListener);
            if (abortGraceTimer) clearTimeout(abortGraceTimer);
          }
          if (forcedStop) {
            forceCleanupChild();
            thrown ??= `Subagent did not stop after cancellation (${ABORT_GRACE_MS / 1000}s grace period)`;
          }
          const assistant = lastAssistantMessage;
          const stopped = cancelled || assistant?.stopReason === "aborted";
          const failed = Boolean(
            thrown ||
            assistant?.errorMessage ||
            assistant?.stopReason === "error",
          );
          const state: TerminalState = timedOut
            ? "timed-out"
            : stopped
              ? "stopped"
              : failed
                ? "failed"
                : "finished";
          let reason = thrown ?? assistant?.errorMessage;
          const rawText = extractTextContent(assistant?.content).trim();
          const truncated = truncateTail(rawText, {
            maxBytes: MODEL_OUTPUT_MAX_BYTES,
            maxLines: MODEL_OUTPUT_MAX_LINES,
          });
          let truncationNote = "";
          let retainedLogFile: string | undefined;
          if (truncated.truncated) {
            try {
              const bytes = Buffer.from(rawText);
              const retained = bytes.subarray(0, MAX_FULL_OUTPUT_BYTES);
              // Retained logs are durable (survive process exit and updates).
              retainedLogFile = retainLog(retained);
              if (!retainedLogFile) {
                const logDir = getLogDir();
                if (logDir) {
                  const logFile = join(logDir, `${randomUUID()}.log`);
                  writeFileSync(logFile, retained, { mode: 0o600 });
                  retainedLogFile = logFile;
                }
              }
              truncationNote = retainedLogFile
                ? bytes.length > retained.length
                  ? `\n\nResult truncated; retained output log (capped at ${MAX_FULL_OUTPUT_BYTES} bytes): ${retainedLogFile}`
                  : `\n\nResult truncated; full output: ${retainedLogFile}`
                : "";
            } catch (logError) {
              console.warn(`Could not save full subagent output:`, logError);
              truncationNote =
                "\n\nResult truncated; full output remains in the durable session file; a temporary log could not be retained.";
            }
          }
          const terminalFields = {
            state,
            durationSec: Math.round((Date.now() - job.startedAt) / 1000),
            updatedAt: new Date().toISOString(),
          } as const;
          const handoffPath = manager.handoffPathFor(completionId);
          if (
            !manager.shuttingDown &&
            manager.generation === expectedGeneration
          ) {
            try {
              job.record = {
                ...manager.currentRecord(job),
                ...terminalFields,
              };
            } catch (statsError) {
              job.record = { ...job.record!, ...terminalFields };
              reason ??= `Could not collect final subagent stats: ${statsError instanceof Error ? statsError.message : String(statsError)}`;
            }
            try {
              saveRecord(job.record);
            } catch (recordError) {
              console.warn(`Could not save final subagent state:`, recordError);
              reason ??= `Could not save final subagent state: ${recordError instanceof Error ? recordError.message : String(recordError)}`;
            }
          } else {
            job.record = { ...job.record!, ...terminalFields };
            if (handoffPath) {
              // Session replaced: persist the terminal record so the next
              // runtime sees a finished child instead of a stale "running".
              try {
                saveRecord(job.record);
              } catch (recordError) {
                console.warn(
                  `Could not save final subagent state:`,
                  recordError,
                );
              }
            }
          }
          const completedRecord = job.record!;
          const usage = completedRecord.usage;
          const costText = usage.cost ? `, $${usage.cost.toFixed(4)}` : "";
          const badge = `\n\n— Subagent ${state} (${completedRecord.durationSec ?? 0}s, ${completedRecord.turns} turn${completedRecord.turns === 1 ? "" : "s"}, ${completedRecord.toolCount} tool${completedRecord.toolCount === 1 ? "" : "s"}${costText}) • Session: ${session.sessionId}`;
          const recovery =
            state === "finished"
              ? ""
              : `\n\nSession ${session.sessionId} is saved and can be resumed with subagent spawn(sessionId: "${session.sessionId}", prompt: "...").`;
          const heading = timedOut
            ? "Background subagent timed out"
            : stopped
              ? "Background subagent was stopped"
              : reason || failed
                ? "Background subagent failed"
                : "Background subagent finished";
          const header = `${heading}: ${label}`;
          const mainContent = truncated.content
            ? `\n\n${truncated.content}`
            : "";
          const reasonText = reason ? `\n\nReason: ${reason}` : "";
          const compact = serializeModelJson({
            v: 1,
            type: "subagent",
            event: "complete",
            sessionId: session.sessionId,
            state,
            ...(truncated.content ? { output: truncated.content } : {}),
            ...(reason ? { reason: sanitizeTerminalOutput(reason) } : {}),
            ...(truncated.truncated ? { outputTruncated: true } : {}),
            ...(retainedLogFile ? { logPath: retainedLogFile } : {}),
            durationSec: completedRecord.durationSec ?? 0,
            turns: completedRecord.turns,
            toolCount: completedRecord.toolCount,
            toolFailures: completedRecord.toolFailures,
            ...(usage.cost ? { cost: usage.cost } : {}),
          });
          const display = `${header}${mainContent}${truncationNote}${reasonText}${recovery}${fallback}${badge}`;
          const completionDetails = {
            sessionId: session.sessionId,
            state,
            durationSec: completedRecord.durationSec ?? 0,
            turns: completedRecord.turns,
            toolCount: completedRecord.toolCount,
            toolFailures: completedRecord.toolFailures,
          };
          if (handoffPath) {
            // The old runtime cannot deliver through the stale extension
            // context; persist the result for the origin session's next
            // runtime.
            manager.writeHandoffResult(handoffPath, {
              message: compact,
              displayMessage: display,
              details: completionDetails,
              triggerTurn: !job.stoppedManually,
            });
          } else {
            manager.deliverCompletion(
              compact,
              job.stoppedManually ? "queue" : (job.completion ?? "queue"),
              expectedGeneration,
              originLeafId,
              !job.stoppedManually,
              completionId,
              display,
              completionDetails,
            );
          }
        } finally {
          clearTimeout(timer);
          if (activityTimer) clearTimeout(activityTimer);
          unsubscribe();
          try {
            await disposeChild();
          } catch (error) {
            console.warn(
              `Could not dispose subagent ${session.sessionId}:`,
              error,
            );
          } finally {
            manager.jobs.delete(pid);
            manager.syncStatus(ctx);
          }
        }
      })();
      manager.track(done);

      const location = branch ? `\nBranch: ${branch}` : "";
      const displayText = `${existing ? "Continued" : "Created"} subagent "${label}" [${displayModel}:${session.thinkingLevel}] • Session: ${session.sessionId}.${location}${fallback}`;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              v: 1,
              type: "subagent",
              action: existing ? "resume" : "spawn",
              pid,
              sessionId: session.sessionId,
              state: "running",
              model: displayModel,
              thinking: session.thinkingLevel,
              completion,
              ...(branch ? { branch } : {}),
            }),
          },
        ],
        details: {
          pid,
          sessionId: session.sessionId,
          model: displayModel,
          thinking: session.thinkingLevel,
          inheritedTools: actualTools,
          context: record.context,
          state: record.state,
          continued: Boolean(existing),
          displayText,
          ...(branch ? { branch } : {}),
          ...(modelFallbackMessage
            ? { modelFallback: modelFallbackMessage }
            : {}),
          ...(toolInheritanceWarning
            ? { toolWarning: toolInheritanceWarning }
            : {}),
        },
      };
    },
    renderCall(args, theme) {
      const safe = (value: unknown) =>
        sanitizeTerminalOutput(String(value ?? ""));
      const action = args.action ?? "spawn";
      if (action === "models")
        return new Text(
          theme.fg("toolTitle", theme.bold("Query subagent models")),
          0,
          0,
        );
      if (action === "status")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(
              `Subagent status${args.sessionId ? `: ${safe(args.sessionId)}` : ""}`,
            ),
          ),
          0,
          0,
        );
      if (action === "stop")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(`Stop subagent ${safe(args.sessionId)}`),
          ),
          0,
          0,
        );
      if (action === "steer")
        return new Text(
          theme.fg(
            "toolTitle",
            theme.bold(
              `Steer subagent ${safe(args.sessionId)}: ${safe(args.message)}`,
            ),
          ),
          0,
          0,
        );

      const label = sanitizeTerminalOutput(
        String(args.description || args.prompt || "..."),
      );
      const shortLabel = label.length > 30 ? `${label.slice(0, 30)}...` : label;
      const modelTag = args.model
        ? ` [${safe(args.model)}${args.thinking ? `:${safe(args.thinking)}` : ""}]`
        : "";
      const completionTag = args.completion === "queue" ? " [queue]" : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`Subagent: ${shortLabel}`))}${theme.fg("dim", modelTag + completionTag)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme, 10);
    },
  });
}
