import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
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
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AssistantMessage,
  type Model,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { SubagentManager } from "./manager.js";
import { shrinkToBudget } from "./manager.js";
import {
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  SUBAGENT_SESSION_DIR,
  SUBAGENT_WORKTREES,
  retainLog,
  type SubagentJob,
  type SubagentRecord,
  type SubagentToolArgs,
  type TerminalState,
} from "./types.js";
import {
  acquireSessionLock,
  describeSubagentModel,
  extractTextContent,
  getScopedModels,
  getSubagentModelCandidates,
  getModelOutputBudget,
  isPathInsideAny,
  isSubagentRecord,
  MODEL_OUTPUT_MAX_LINES,
  readIndex,
  renderToolResult,
  resolveSubagentCwd,
  sanitizeTerminalOutput,
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

export function resolveCompletion(
  requested: "queue" | "continue" | undefined,
  background = false,
): "queue" | "continue" {
  return requested ?? (background ? "queue" : "continue");
}

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
  const runtimeRefreshes = new WeakMap<
    ModelRuntime,
    { refreshedAt: number; promise?: Promise<void> }
  >();
  const RUNTIME_REFRESH_TTL_MS = 5_000;

  function refreshRuntime(runtime: ModelRuntime, force = false): Promise<void> {
    if (typeof runtime.refresh !== "function") return Promise.resolve();
    const now = Date.now();
    const state = runtimeRefreshes.get(runtime) ?? { refreshedAt: 0 };
    if (state.promise) return state.promise;
    if (!force && now - state.refreshedAt < RUNTIME_REFRESH_TTL_MS)
      return Promise.resolve();

    let promise: Promise<void>;
    promise = Promise.resolve()
      .then(async () => {
        const result = await runtime.refresh({ allowNetwork: false });
        if (!result || !result.errors || result.errors.size === 0)
          state.refreshedAt = Date.now();
      })
      .catch(() => {})
      .finally(() => {
        if (state.promise === promise) state.promise = undefined;
      });
    state.promise = promise;
    runtimeRefreshes.set(runtime, state);
    return promise;
  }

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

  // Peek support: cheap tail read of the child's session file, scanning
  // backwards for the most recent assistant text. Tolerates partial lines
  // at the window start and missing/unreadable files.
  const PEEK_TAIL_BYTES = 64 * 1024;
  const PEEK_OUTPUT_CHARS = 600;
  function readLastAssistantText(
    sessionFile: string,
    maxChars: number,
  ): string | undefined {
    try {
      const stat = statSync(sessionFile);
      if (!stat.isFile()) return undefined;
      const start = Math.max(0, stat.size - PEEK_TAIL_BYTES);
      const length = stat.size - start;
      const buffer = Buffer.alloc(length);
      const handle = openSync(sessionFile, "r");
      try {
        readSync(handle, buffer, 0, length, start);
      } finally {
        closeSync(handle);
      }
      const lines = buffer.toString("utf8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!.trim();
        if (!line) continue;
        let entry: {
          type?: string;
          message?: { role?: string; content?: Array<unknown> };
        };
        try {
          entry = JSON.parse(line);
        } catch {
          continue; // partial first line of the tail window
        }
        if (entry?.type !== "message" || entry.message?.role !== "assistant")
          continue;
        const text = (entry.message.content ?? [])
          .map((part) =>
            part && typeof part === "object" && "text" in part
              ? (part as { text?: unknown }).text
              : undefined,
          )
          .filter((text): text is string => typeof text === "string")
          .join("\n")
          .trim();
        if (!text) continue;
        return text.length > maxChars ? `…${text.slice(-maxChars)}` : text;
      }
      return undefined;
    } catch {
      return undefined;
    }
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

  async function listLiveSubagentModels(ctx: ExtensionContext, offset = 0) {
    const parentRuntime = (ctx.modelRegistry as any)?.runtime as
      ModelRuntime | undefined;
    if (parentRuntime) await refreshRuntime(parentRuntime);
    return listSubagentModels(ctx, offset);
  }

  function listSubagentModels(ctx: ExtensionContext, offset = 0) {
    const candidates = getSubagentModelCandidates(ctx);
    const page = candidates.slice(offset, offset + MAX_LIST_ITEMS);
    const models = page.map((candidate) =>
      describeSubagentModel(candidate, ctx.model),
    );
    const nextOffset =
      offset + models.length < candidates.length
        ? offset + models.length
        : undefined;
    const unrestricted = getScopedModels(ctx).length === 0;
    const display = `${unrestricted ? "Available subagent models" : "Scoped subagent models"}:\n${models
      .map(
        (entry) =>
          `- ${entry.model}${entry.current ? " (current)" : ""}${entry.reasoning ? " [reasoning]" : ""}`,
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
            current: ctx.model
              ? `${ctx.model.provider}/${ctx.model.id}`
              : undefined,
            models,
            ...(nextOffset !== undefined ? { nextOffset } : {}),
            total: candidates.length,
          }),
        },
      ],
      details: {
        models,
        unrestricted,
        nextOffset,
        total: candidates.length,
        displayText: display,
      },
    };
  }

  pi.registerTool({
    name: "subagent_models",
    label: "Subagent Models",
    description: "live models for subagent selection.",
    promptSnippet: "live models for subagent selection.",
    parameters: Type.Object({
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Offset from previous nextOffset",
        }),
      ),
    }),
    async execute(_id, args: { offset?: number }, _signal, _up, ctx) {
      // Match the legacy action:"models" path so both entry points report
      // the same live availability.
      return listLiveSubagentModels(ctx, Math.max(0, args.offset ?? 0));
    },
    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Subagent models")),
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme, 12);
    },
  });

  const subagentCommand = {
    description: "List and manage background subagents",
    getArgumentCompletions: (prefix: string) => {
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
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
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
        ctx.ui.notify("Usage: /subagents kill <pid>", "error");
        return;
      }
      if (trimmed) {
        ctx.ui.notify(
          `Unknown /subagents argument: ${sanitizeTerminalOutput(trimmed)}`,
          "error",
        );
        return;
      }
      if (ctx.hasUI) await manager.manageJobs(ctx);
    },
  };
  pi.registerCommand("subagents", subagentCommand);
  // Backward-compatible alias for the pre-rename command name.
  pi.registerCommand("subagent", {
    ...subagentCommand,
    description: "Alias of /subagents",
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "delegate — child session for independent work. Inherits parent model/tools/cwd. Pass sessionId from a prior result to continue that session: it resumes when finished, or steers while still running. sessionId also accepts stop:true to interrupt it or peek:true to check on it.",
    promptSnippet: "delegate to child session.",
    promptGuidelines: [
      "delegate: keep simple work in parent; batch independent work in parallel in one turn.",
      "isolate: the child sees only your prompt — write a self-contained brief with paths, constraints, and done-criteria checkable by evidence; state the target behavior rather than prohibitions; omit model to inherit parent.",
      "select: reach subagent_models only when reasoning/context/cost matters.",
      "dispatch: worktree:true for concurrent writes; background:true returns immediately and delivers its result as a new message that restarts your turn — end your turn after dispatching instead of holding it open.",
      "continue: pass sessionId from any subagent result with a follow-up prompt; it resumes a finished session or steers a running one.",
      "control: sessionId + stop:true interrupts the child; sessionId + peek:true reports progress and last output cheaply.",
    ],
    executionMode: "parallel" as const,
    prepareArguments(args: unknown) {
      // Legacy callers may still pass tool arrays; the public contract does
      // not expose tool selection, but accepting the old shape is harmless.
      if (args && typeof args === "object" && !Array.isArray(args)) {
        const raw = args as Record<string, unknown>;
        if (Array.isArray(raw.tools))
          return { ...raw, tools: raw.tools.join(",") };
      }
      return args as any;
    },
    parameters: Type.Object(
      {
        prompt: Type.Optional(
          Type.String({ description: "Task for child session" }),
        ),
        model: Type.Optional(
          Type.String({
            description: "Exact provider/model ID from subagent_models",
          }),
        ),
        worktree: Type.Optional(
          Type.Boolean({
            description: "Isolated Git worktree",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "Return immediately; the finished result arrives later as a new message that starts a turn",
          }),
        ),
        sessionId: Type.Optional(
          Type.String({
            description:
              "Existing subagent session from an earlier result. Still running: delivers prompt as guidance. Otherwise: resumes it with prompt.",
          }),
        ),
        stop: Type.Optional(
          Type.Boolean({
            description: "Interrupt the targeted session. Requires sessionId.",
          }),
        ),
        peek: Type.Optional(
          Type.Boolean({
            description:
              "Return the targeted session's state, current activity, and last output without disturbing it. Requires sessionId.",
          }),
        ),
      },
      { additionalProperties: true },
    ),
    async execute(_id, args: SubagentToolArgs, signal, _up, ctx) {
      // Keep the old control payloads readable for durable sessions and direct
      // callers, while exposing only the small spawn contract above to the LLM.
      let {
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
        background = false,
        context = "project",
        timeoutSec = 1800,
        stop = false,
        peek = false,
      } = args;
      manager.currentCtx = ctx;
      const originLeafId = ctx.sessionManager.getLeafId();
      const needsModelResolution = action === "spawn";
      const configuredScope = needsModelResolution
        ? [...getScopedModels(ctx)]
        : [];
      const availableModels = needsModelResolution
        ? ctx.modelRegistry.getAvailable()
        : [];
      const availableIds = new Set(
        availableModels.map(
          (candidate) => `${candidate.provider}/${candidate.id}`,
        ),
      );
      const scopeRestricted = configuredScope.length > 0;
      const scopedModels = configuredScope.filter((entry) =>
        availableIds.has(`${entry.model.provider}/${entry.model.id}`),
      );
      const selectionCandidates = needsModelResolution
        ? getSubagentModelCandidates(ctx)
        : [];
      const requestedId = sessionId?.trim();
      let durableCache: Record<string, SubagentRecord> | undefined;
      const getDurable = () => (durableCache ??= readIndex());
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
        if (/^[a-zA-Z0-9-]+$/.test(id)) {
          const directFile = join(SUBAGENT_INDEX, `${id}.json`);
          if (existsSync(directFile)) {
            try {
              const record = JSON.parse(readFileSync(directFile, "utf8"));
              if (isSubagentRecord(record)) return record;
            } catch {}
          }
        }
        const durable = getDurable();
        if (Object.hasOwn(durable, id)) return durable[id];
        return findBySessionPrefix(Object.values(durable), id, "sessions");
      };

      const matching = requestedId
        ? findActiveSubagent(requestedId)
        : undefined;

      // ── Interactive verbs on an existing session: interrupt or glance ──
      if ((stop || peek) && !requestedId)
        throw new Error(
          `sessionId is required to ${stop ? "stop" : "peek at"} a subagent`,
        );
      if (stop && requestedId) {
        if (matching) {
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
        const record = findDurableRecord(requestedId);
        if (!record)
          throw new Error(
            `Subagent session not found in ${SUBAGENT_INDEX}: ${requestedId}`,
          );
        // Already terminal: report instead of erroring so the caller does
        // not burn a retry on a no-op.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                v: 1,
                type: "subagent",
                action: "stop",
                sessionId: record.sessionId,
                state: record.state,
                note: "not running",
              }),
            },
          ],
          details: {
            sessionId: record.sessionId,
            state: record.state,
            displayText: `Subagent ${record.sessionId} is not running (${record.state})`,
          },
        };
      }
      if (peek && requestedId) {
        const record = matching?.record ?? findDurableRecord(requestedId);
        if (!matching && !record)
          throw new Error(
            `Subagent session not found in ${SUBAGENT_INDEX}: ${requestedId}`,
          );
        const state = matching
          ? matching.stopping
            ? "stopping"
            : "running"
          : record!.state;
        const output = record
          ? readLastAssistantText(record.sessionFile, PEEK_OUTPUT_CHARS)
          : undefined;
        const payload: Record<string, unknown> = {
          v: 1,
          type: "subagent",
          action: "peek",
          sessionId: record?.sessionId ?? requestedId,
          state,
          ...(record?.model ? { model: record.model } : {}),
          ...(matching?.activity ? { activity: matching.activity } : {}),
          ...(record?.turns !== undefined ? { turns: record.turns } : {}),
          ...(matching
            ? {
                elapsedSec: Math.round(
                  (Date.now() - matching.startedAt) / 1000,
                ),
              }
            : {}),
          ...(record?.durationSec ? { durationSec: record.durationSec } : {}),
          ...(output ? { output } : {}),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(payload),
            },
          ],
          details: {
            sessionId: record?.sessionId ?? requestedId,
            state,
            displayText: `Peeked at subagent ${record?.sessionId ?? requestedId}: ${state}${matching?.activity ? ` (${matching.activity})` : ""}`,
          },
        };
      }

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
        let registeredProvider = false;
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
              const alreadyRegistered =
                typeof runtime.getProvider === "function" &&
                Boolean(runtime.getProvider(providerId));
              if (alreadyRegistered) continue;
              if (
                native &&
                typeof runtime.registerNativeProvider === "function"
              ) {
                runtime.registerNativeProvider(native);
                registeredProvider = true;
              } else if (
                config &&
                typeof runtime.registerProvider === "function"
              ) {
                runtime.registerProvider(providerId, config);
                registeredProvider = true;
              } else if (typeof runtime.registerNativeProvider === "function") {
                const provider = ctx.modelRegistry.getProvider?.(providerId);
                if (provider) {
                  runtime.registerNativeProvider(provider);
                  registeredProvider = true;
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
        if (registeredProvider || !parentRuntime)
          await refreshRuntime(runtime, true);
        const modelSpec = opts.model?.trim();
        let resolvedModel: Model<any> | undefined;
        let resolvedThinking: ThinkingLevel | undefined;
        let modelRequestWarning: string | undefined;
        if (modelSpec) {
          if (scopeRestricted && selectionCandidates.length === 0)
            throw new Error(
              "No models in the live session scope are currently available; adjust /scoped-models or provider authentication",
            );
          if (selectionCandidates.length > 0) {
            const lowerSpec = modelSpec.toLowerCase();
            const exactMatches = selectionCandidates.filter(
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
            const matches = selectionCandidates.filter(
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
              const allNames = selectionCandidates.map(
                (s) => `${s.model.provider}/${s.model.id}`,
              );
              const listed = allNames.slice(0, 8);
              const availableNames =
                listed.join(", ") +
                (allNames.length > listed.length
                  ? `, +${allNames.length - listed.length} more`
                  : "");
              throw new Error(
                scopeRestricted
                  ? `Model '${modelSpec}' is outside the live session scope. Query subagent_models and retry. Scope: ${availableNames}`
                  : `Model '${modelSpec}' is unavailable. Query subagent_models or omit model to inherit the parent`,
              );
            }
          } else {
            throw new Error(
              `Model '${modelSpec}' is unavailable; omit model to inherit the parent`,
            );
          }
        }
        if (!modelSpec && existing && scopeRestricted) {
          if (!scopedModels.length)
            throw new Error(
              "No models in the live session scope are currently available; adjust /scoped-models or provider authentication",
            );
          const savedInScope = scopedModels.find(
            (entry) =>
              `${entry.model.provider}/${entry.model.id}` === opts.savedModel,
          );
          if (!savedInScope) {
            const parentInScope = scopedModels.find(
              (entry) =>
                entry.model.provider === ctx.model?.provider &&
                entry.model.id === ctx.model?.id,
            );
            if (parentInScope) {
              resolvedModel = parentInScope.model;
              resolvedThinking = parentInScope.thinkingLevel as
                ThinkingLevel | undefined;
            } else if (ctx.model) {
              resolvedModel = ctx.model;
              resolvedThinking = ctx.thinkingLevel as ThinkingLevel | undefined;
            } else {
              const fallback = scopedModels[0];
              resolvedModel = fallback.model;
              resolvedThinking = fallback.thinkingLevel as
                ThinkingLevel | undefined;
            }
            modelRequestWarning = `Saved model ${opts.savedModel ?? "unknown"} left the live scope; resumed with ${resolvedModel!.provider}/${resolvedModel!.id}`;
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
        const childTools =
          explicitTools ?? parentTools.filter((name) => name !== "subagent");
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
            ? scopedModels?.find(
                (s) =>
                  s.model.id === ctx.model?.id &&
                  s.model.provider === ctx.model?.provider,
              )
            : undefined;
        const savedEntry =
          existing && !resolvedModel && opts.savedModel
            ? selectionCandidates.find(
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
        const agentDir = getAgentDir();
        const resourceLoader = new DefaultResourceLoader({
          cwd: opts.cwd,
          agentDir,
          settingsManager,
          ...(temporaryExtensionPaths.length
            ? { additionalExtensionPaths: temporaryExtensionPaths }
            : {}),
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.filter(
              (ext) =>
                !ext.tools.has("subagent") &&
                !ext.path.includes("pi-subagents") &&
                !ext.resolvedPath.includes("pi-subagents"),
            ),
          }),
          ...(!trusted
            ? {
                agentsFilesOverride: (base) => ({
                  agentsFiles: base.agentsFiles.filter((f) =>
                    f.path.startsWith(agentDir + sep),
                  ),
                }),
              }
            : {}),
        });
        if (!trusted) {
          // Global extensions remain available for tools, but cannot inject
          // project skills, prompts, or themes into an untrusted child.
          resourceLoader.extendResources = () => {};
        }
        globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ =
          (globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ ?? 0) + 1;
        try {
          await resourceLoader.reload();
        } finally {
          const loads =
            (globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ ?? 1) - 1;
          if (loads > 0)
            globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__ = loads;
          else delete globalThis.__PI_SUBAGENTS_CHILD_RESOURCE_LOAD__;
        }
        checkSetup?.();
        const setupController = new AbortController();
        let created: Awaited<ReturnType<typeof createAgentSession>> | undefined;
        if (scopeRestricted && scopedModels.length === 0)
          // Fresh spawn without an explicit model must not silently widen an
          // empty live scope to unrestricted; match the explicit/resume paths.
          throw new Error(
            "No models in the live session scope are currently available; adjust /scoped-models or provider authentication",
          );
        try {
          created = await createAgentSession({
            cwd: opts.cwd,
            modelRuntime: runtime,
            sessionManager: opts.sessionManager,
            settingsManager,
            scopedModels: scopedModels.length > 0 ? scopedModels : undefined,
            sessionStartEvent: {
              type: "session_start",
              reason: existing ? "resume" : "startup",
              previousSessionFile: existing
                ? opts.sessionManager.getSessionFile()
                : undefined,
            },
            ...(resourceLoader ? { resourceLoader } : {}),
            tools: childTools,
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
            ) &&
            !(
              ctx.model?.provider === initializedModel.provider &&
              ctx.model.id === initializedModel.id
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
          await refreshRuntime(runtime, true);
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
          model: initializedModel,
          modelFallbackMessage: modelFallbackMessage || undefined,
          toolInheritanceWarning,
          actualTools,
          dispose,
          forceDispose,
        };
      };

      if (action === "models") {
        return listLiveSubagentModels(ctx, Math.max(0, modelOffset));
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
              ...Object.values(getDurable())
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
      // Native contract: subagent(sessionId, prompt) without an explicit
      // action targets an existing session — steer it while it streams,
      // otherwise fall through and resume it in the spawn path below.
      const explicitAction = Boolean((args as Record<string, unknown>)?.action);
      if (
        !explicitAction &&
        requestedId &&
        prompt?.trim() &&
        matching?.session?.isStreaming &&
        matching.session.steer
      ) {
        action = "steer";
        message = prompt;
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
        if (!message?.trim()) throw new Error("message is required for steer");
        // session.steer() only queues while the agent is streaming; reject
        // instead of silently losing guidance to a completion race.
        if (!matching.session.isStreaming || !matching.session.steer)
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
      if (!prompt?.trim()) throw new Error("prompt is required");
      // Normal delegation wakes the parent when the child finishes. The
      // explicit background escape hatch keeps the result queued silently.
      completion = resolveCompletion(completion, background);
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
      if (context === "fork")
        throw new Error(
          "context:fork is no longer supported; use the default project context",
        );
      const releaseSetup = manager.trackSetup(setupController);
      let setupReleased = false;
      const releaseTrackedSetup = () => {
        if (!setupReleased) {
          setupReleased = true;
          releaseSetup();
        }
      };
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
            if (existing.branch)
              throw new Error(
                `cwd cannot be combined with a worktree subagent resume (saved cwd: ${existing.cwd})`,
              );
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
      let childModel: Awaited<ReturnType<typeof setupChildSession>>["model"];
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
            sessionLock = acquireSessionLock(
              existing.sessionId,
              SUBAGENT_LOCKS,
            );
          }
          const parentSessionFile = ctx.sessionManager.getSessionFile();
          sessionManager = existing
            ? SessionManager.open(
                validatedSessionFile ?? existing.sessionFile,
                SUBAGENT_SESSION_DIR,
                childCwd,
              )
            : SessionManager.create(childCwd, SUBAGENT_SESSION_DIR, {
                parentSession: parentSessionFile,
              });
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
          prepared = await setupChildSession({
            cwd: childCwd,
            model,
            thinking: thinking as ThinkingLevel | undefined,
            tools,
            sessionManager,
            existing: Boolean(existing),
            savedModel: existing?.model,
            savedThinking: existing?.thinking,
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
        childModel = prepared.model;
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
        try {
          if (!existing) {
            sessionManager.appendCustomEntry("pi-subagents", {
              createdAt: new Date().toISOString(),
            });
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

      const pid = manager.nextVirtualPid++;
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
      const displayModel = `${childModel.provider}/${childModel.id}`;
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
        };
        manager.jobs.set(pid, job);
        saveRecord(record);
        manager.pi.events?.emit("subagent:spawn", {
          pid: job.pid,
          sessionId: session.sessionId,
          label: job.command,
          model: job.record.model,
          cwd: job.record.cwd,
          worktree: Boolean(job.record.branch),
        });
        checkSetup();
        finishSetup();
      } catch (error) {
        try {
          await disposeChild();
        } catch {}
        // The jobs map is process-global and pids can be reused by a newer
        // generation after a forced cleanup; only delete our own job.
        if (manager.jobs.get(pid) === job) manager.jobs.delete(pid);
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
                manager.syncStatus();
              }
            }, TOOL_ACTIVITY_HOLD_MS);
            activityTimer.unref?.();
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
        manager.syncStatus();
        manager.pi.events?.emit("subagent:progress", {
          pid: job.pid,
          sessionId: job.sessionId,
          activity: job.activity,
          turns: job.record.turns,
          toolCount: job.record.toolCount,
        });
      };
      const unsubscribe = session.subscribe((event) => {
        if (
          (event.type === "message_update" || event.type === "message_end") &&
          event.message.role === "assistant"
        ) {
          lastAssistantMessage = event.message;
        }
        if (event.type === "turn_start") setActivity("thinking");
        else if (event.type === "compaction_start")
          setActivity("compacting context");
        else if (event.type === "compaction_end") setActivity("thinking");
        else if (event.type === "auto_retry_start") {
          const attempt = (event as any).attempt;
          setActivity(
            typeof attempt === "number"
              ? `retrying (${attempt})...`
              : "retrying...",
          );
        } else if (event.type === "auto_retry_end") setActivity("thinking");
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
      timer.unref?.();
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
          const resultBudget = Math.floor(
            getModelOutputBudget(
              session.model as { contextWindow?: number } | undefined,
            ) / 2,
          );
          const truncated = truncateTail(rawText, {
            maxBytes: resultBudget,
            maxLines: MODEL_OUTPUT_MAX_LINES,
          });
          let truncationNote = "";
          let retainedLogFile: string | undefined;
          const retainFullOutput = () => {
            try {
              const bytes = Buffer.from(rawText);
              const retained = bytes.subarray(0, MAX_FULL_OUTPUT_BYTES);
              // Retained logs are durable (survive process exit and updates).
              retainedLogFile = retainLog(retained);
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
          };
          if (truncated.truncated) retainFullOutput();
          const terminalFields = {
            state,
            durationSec: Math.round((Date.now() - job.startedAt) / 1000),
            updatedAt: new Date().toISOString(),
          } as const;
          if (!manager.shuttingDown && manager.jobs.has(pid)) {
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
          }
          const completedRecord = job.record!;
          const usage = completedRecord.usage;
          const costText = usage.cost ? `, $${usage.cost.toFixed(4)}` : "";
          const branchText = completedRecord.branch
            ? ` • Branch: ${completedRecord.branch} — inspect with git diff HEAD..${completedRecord.branch}, then git merge --no-ff ${completedRecord.branch} and delete the branch`
            : "";
          const badge = `\n\n— Subagent ${state} (${completedRecord.durationSec ?? 0}s, ${completedRecord.turns} turn${completedRecord.turns === 1 ? "" : "s"}, ${completedRecord.toolCount} tool${completedRecord.toolCount === 1 ? "" : "s"}${costText}) • Session: ${session.sessionId}${branchText}`;
          const recovery =
            state === "finished"
              ? ""
              : `\n\nSession ${session.sessionId} is saved; resume it with subagent({ sessionId: "${session.sessionId}", prompt: "..." }).`;
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
          manager.pi.events?.emit("subagent:complete", {
            pid: job.pid,
            sessionId: session.sessionId,
            state,
            durationSec: completedRecord.durationSec ?? 0,
            usage: completedRecord.usage,
            logPath: retainedLogFile,
          });
          const payload: Record<string, unknown> = {
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
          };
          if (
            !truncated.truncated &&
            truncated.content &&
            Buffer.byteLength(JSON.stringify(payload)) > resultBudget
          ) {
            // JSON escaping inflated the serialized output past the budget;
            // keep the raw text recoverable instead of silently dropping it.
            retainFullOutput();
            payload.outputTruncated = true;
            if (retainedLogFile) payload.logPath = retainedLogFile;
          }
          const compact = serializeModelJson(payload, "output", resultBudget);
          const display = `${header}${mainContent}${truncationNote}${reasonText}${recovery}${fallback}${badge}`;
          const completionDetails = {
            sessionId: session.sessionId,
            state,
            durationSec: completedRecord.durationSec ?? 0,
            turns: completedRecord.turns,
            toolCount: completedRecord.toolCount,
            toolFailures: completedRecord.toolFailures,
          };
          if (background) {
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
          return {
            compact,
            display,
            completionDetails,
          };
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
            if (manager.jobs.get(pid) === job) manager.jobs.delete(pid);
            manager.syncStatus();
          }
        }
      })();
      manager.track(done);

      if (signal) {
        if (signal.aborted) {
          controller.abort();
        } else {
          signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        }
      }

      if (!background) {
        const result = await done;
        return {
          content: [
            {
              type: "text",
              // A child with a larger context window than the parent can
              // exceed the parent's delivery budget; shrink before returning.
              text: shrinkToBudget(
                result.compact,
                getModelOutputBudget(ctx.model),
              ),
            },
          ],
          details: {
            ...result.completionDetails,
            displayText: result.display,
            ...(branch ? { branch } : {}),
            ...(modelFallbackMessage
              ? { modelFallback: modelFallbackMessage }
              : {}),
            ...(toolInheritanceWarning
              ? { toolWarning: toolInheritanceWarning }
              : {}),
          },
        };
      }

      const location = branch ? `\nBranch: ${branch}` : "";
      // State the wake contract at dispatch time: models hold their turn
      // open with sleep loops when they believe ending the turn loses the
      // result. Delivery restarts an idle parent automatically.
      const backgroundNote = background
        ? " Runs in background; the result arrives as a new message that starts a turn. End your turn once independent work is done."
        : "";
      const displayText = `${existing ? "Continued" : "Created"} subagent "${label}" [${displayModel}:${session.thinkingLevel}] • Session: ${session.sessionId}.${location}${fallback}${backgroundNote}`;
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
    renderCall(args: any, theme) {
      const label = sanitizeTerminalOutput(String(args.prompt || "..."));
      const shortLabel = label.length > 60 ? `${label.slice(0, 60)}...` : label;
      const tags = [
        args.worktree ? "worktree" : "",
        args.background ? "background" : "",
      ]
        .filter(Boolean)
        .join(", ");
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`Subagent: ${shortLabel}`))}${tags ? theme.fg("dim", ` [${tags}]`) : ""}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderToolResult(result, options, theme, 10);
    },
  });
}
