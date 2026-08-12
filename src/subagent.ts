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
  LEGACY_SUBAGENT_LOCKS,
  LEGACY_SUBAGENT_SESSION_DIR,
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  SUBAGENT_SESSION_DIR,
  SUBAGENT_WORKTREES,
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
  readIndex,
  renderToolResult,
  resolveSubagentCwd,
  sanitizeTerminalOutput,
  sanitizeForkMessages,
  saveRecord,
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
        s.state === "running" ? "●" : s.state === "finished" ? "✓" : "✖";
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
      "Delegate exploration or research tasks to a background subagent. Results are capped at 50KB or 2000 lines; truncated output is saved to a private log and the durable child session remains resumable.",
    promptSnippet:
      "Delegate exploration or research tasks to a background subagent.",
    promptGuidelines: [
      "Use subagent for multi-step sub-tasks, background research, code audits, refactoring, or sub-problems to keep main context uncluttered.",
      "Choose appropriate models for subagents based on task requirements (e.g. fast/inexpensive models for simple searches or checks, strong reasoning models with thinking for complex refactoring).",
      "Provide complete and self-contained instructions in prompt; use context:fork only when the child needs the parent's current conversation.",
      "Reuse sessionId from an earlier subagent result to continue its saved model, thinking level, cwd, and conversation.",
      "For high-level or non-technical requests ('check performance', 'audit security', 'investigate codebase'), delegate isolated sub-tasks to subagent.",
      "For independent tasks that don't depend on each other, spawn multiple subagents in one turn; each runs in the background and its result arrives as it finishes.",
      "For sequential work that builds on prior results, spawn one subagent, then spawn the next with the previous result in its prompt.",
      "Use worktree:true for concurrent writing subagents; pi-subagents creates but never merges or removes the branch/worktree.",
      "After starting a subagent, continue work immediately; NEVER execute sleep, loop, or poll commands to wait for completion. Return response to user or perform other tasks. Subagent results will arrive automatically when ready.",
    ],
    parameters: Type.Object({
      action: Type.Optional(
        StringEnum(["spawn", "status", "steer", "stop"] as const, {
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
            "continue wakes the parent turn automatically when ready (default); queue does not start a new turn while the parent is idle",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Model override from the active scope; without a scope, the parent model is used; omitted on resume to restore the saved model",
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
        checkSetup?: () => void; // spawn: guard against parent session end
        setupSignal?: AbortSignal;
        shutdownHandler?: () => void; // caller controller to abort on ctx.shutdown()
      };
      const setupChildSession = async (opts: ChildSetupOptions) => {
        const { existing = false, checkSetup, shutdownHandler } = opts;
        const runtimePromise = (modelRuntime ??= ModelRuntime.create());
        void runtimePromise.catch(() => {
          if (modelRuntime === runtimePromise) modelRuntime = undefined;
        });
        const runtime = await awaitWithoutCancelling(
          runtimePromise,
          opts.setupSignal,
        );
        checkSetup?.();
        for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
          try {
            const native =
              ctx.modelRegistry.getRegisteredNativeProvider(providerId);
            const config =
              ctx.modelRegistry.getRegisteredProviderConfig(providerId);
            if (native) {
              runtime.registerNativeProvider(native);
            } else if (config) {
              runtime.registerProvider(providerId, config);
            } else {
              const provider = ctx.modelRegistry.getProvider(providerId);
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
        const modelSpec = opts.model?.trim();
        let modelRequestWarning: string | undefined;
        let resolvedModel: Model<any> | undefined;
        let resolvedThinking: ThinkingLevel | undefined;
        const scopedList = getScopedModels(ctx);
        if (modelSpec) {
          if (scopedList.length > 0) {
            const lowerSpec = modelSpec.toLowerCase();
            const exactMatches = scopedList.filter(
              (s) =>
                `${s.model.provider}/${s.model.id}`.toLowerCase() ===
                  lowerSpec ||
                (!lowerSpec.includes("/") &&
                  s.model.id.toLowerCase() === lowerSpec),
            );
            if (exactMatches.length > 1) {
              throw new Error(
                `Ambiguous model specifier '${modelSpec}' matched multiple scoped models: ${exactMatches.map((s) => `${s.model.provider}/${s.model.id}`).join(", ")}`,
              );
            }
            const matches = scopedList.filter(
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
                `Ambiguous model specifier '${modelSpec}' matched multiple scoped models: ${matches.map((s) => `${s.model.provider}/${s.model.id}`).join(", ")}`,
              );
            }
            if (matched) {
              resolvedModel = matched.model;
              // ScopedModel.thinkingLevel is typed from pi-agent-core; the
              // literal union is identical to pi-ai's ThinkingLevel.
              resolvedThinking = matched.thinkingLevel as
                ThinkingLevel | undefined;
            } else {
              const availableNames = scopedList
                .map((s) => `${s.model.provider}/${s.model.id}`)
                .join(", ");
              throw new Error(
                `Requested model '${modelSpec}' is not in the active model scope. Available scoped models: ${availableNames}`,
              );
            }
          } else {
            modelRequestWarning = `Requested model '${modelSpec}' was ignored because no active model scope exists; using the parent model`;
            console.warn(modelRequestWarning);
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
        const selectedModel =
          resolvedModel ??
          (!existing ? (scopedEntry?.model ?? ctx.model) : undefined);
        const effectiveThinking =
          requestedThinking ??
          (!existing
            ? (scopedEntry?.thinkingLevel ?? ctx.thinkingLevel)
            : undefined);
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
        if (!session.model) {
          await dispose();
          throw new Error("Subagent session did not initialize a model");
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
          const inheritedTools = parentTools.filter((name) =>
            actualTools.includes(name),
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
              ...Array.from(active.values(), (job) => job.record!),
              ...Object.values(durable)
                .filter((record) => !active.has(record.sessionId))
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                .slice(0, 5),
            ];
        const sessions = records.map((record) =>
          statusDetails(record, active.get(record.sessionId)),
        );
        const text = formatSubagentStatusTable(sessions);
        const nudge = active.size
          ? "\n\nSubagent results are delivered automatically when ready; check status once for a single diagnostic, not in a polling loop."
          : "";
        return {
          content: [{ type: "text" as const, text: text + nudge }],
          details: { sessions },
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
              text: `Stopped subagent ${matching.sessionId}`,
            },
          ],
          details: { sessionId: matching.sessionId },
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
              text: `Queued steering for subagent ${matching.sessionId} after its current turn`,
            },
          ],
          details: { sessionId: matching.sessionId, queued: true },
        };
      }
      if (!prompt?.trim()) throw new Error("prompt is required for spawn");
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
          try {
            rmSync(sessionLock, { recursive: true, force: true });
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
            const lockDir =
              validatedSessionFile &&
              isPathInside(LEGACY_SUBAGENT_SESSION_DIR, validatedSessionFile)
                ? LEGACY_SUBAGENT_LOCKS
                : SUBAGENT_LOCKS;
            sessionLock = acquireSessionLock(existing.sessionId, lockDir);
          }
          sessionManager = existing
            ? SessionManager.open(
                validatedSessionFile ?? existing.sessionFile,
                SUBAGENT_SESSION_DIR,
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
          prepared = await setupChildSession({
            cwd: childCwd,
            model,
            thinking: thinking as ThinkingLevel | undefined,
            tools,
            sessionManager,
            existing: Boolean(existing),
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

      const pid = manager.nextVirtualPid++;
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
          forceCleanup: forceCleanupChild,
          session,
          activity: "starting",
          completion,
          baseline: session.getSessionStats(),
          record,
          toolFailures: 0,
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
          const truncated = truncateTail(rawText);
          let truncationNote = "";
          if (truncated.truncated) {
            const logFile = join(getLogDir(), `${randomUUID()}.log`);
            try {
              writeFileSync(logFile, rawText, { mode: 0o600 });
              truncationNote = `\n\nResult truncated; full output: ${logFile}`;
            } catch (logError) {
              console.warn(`Could not save full subagent output:`, logError);
              truncationNote =
                "\n\nResult truncated; full output remains in the durable session file.";
            }
          }
          const terminalFields = {
            state,
            durationSec: Math.round((Date.now() - job.startedAt) / 1000),
            updatedAt: new Date().toISOString(),
          } as const;
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
          manager.deliverCompletion(
            `${header}${mainContent}${truncationNote}${reasonText}${recovery}${fallback}${badge}`,
            job.stoppedManually ? "queue" : (job.completion ?? "continue"),
            expectedGeneration,
            originLeafId,
            !job.stoppedManually,
          );
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
      const queueMsg =
        completion === "queue"
          ? " Output queued without starting a new turn while idle."
          : " The result will arrive automatically.";
      return {
        content: [
          {
            type: "text",
            text: `${existing ? "Continued" : "Created"} subagent "${label}" [${displayModel}:${session.thinkingLevel}] • Session: ${session.sessionId}.${queueMsg}${location}${fallback}`,
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
