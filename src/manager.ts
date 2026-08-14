import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Text,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  HANDOFF_DIR,
  SUBAGENT_DIR,
  SUBAGENT_SESSION_DIR,
  type SubagentJob,
  type SubagentRecord,
} from "./types.js";

declare global {
  var __PI_SUBAGENTS_ACTIVE_JOBS__: Map<number, SubagentJob> | undefined;
}

function getGlobalActiveJobs(): Map<number, SubagentJob> {
  return (globalThis.__PI_SUBAGENTS_ACTIVE_JOBS__ ??= new Map<
    number,
    SubagentJob
  >());
}

export interface HandoffEntry {
  v: 1;
  pid: number;
  sessionId?: string;
  sessionFile: string;
  parentSessionId?: string;
  originLeafId: string | null;
  startedAt: number;
  completion: "queue" | "continue";
  completionId: string;
  expectedGeneration: number;
  command?: string;
  result?: {
    message: string;
    displayMessage?: string;
    details?: unknown;
    triggerTurn: boolean;
  };
}

const HANDED_OFF_SESSION: any = {
  model: undefined,
  thinkingLevel: undefined,
  getSessionStats: () => ({
    assistantMessages: 0,
    toolCalls: 0,
    tokens: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
    cost: 0,
  }),
};
import {
  createMarkdownComponent,
  displayText,
  ensurePrivateDir,
  MODEL_OUTPUT_MAX_BYTES,
  processIsAlive,
  readIndex,
  sanitizeTerminalOutput,
  saveRecord,
  usageSince,
} from "./utils.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_REFRESH_MS = 200;

export class SubagentManager {
  public jobs: Map<number, SubagentJob> = getGlobalActiveJobs();
  public nextVirtualPid = 1;

  public getNextPid(): number {
    let max = 0;
    for (const pid of this.jobs.keys()) {
      if (pid > max) max = pid;
    }
    return Math.max(this.nextVirtualPid, max + 1);
  }
  public currentCtx: ExtensionContext | undefined;
  public generation = 0;
  public shuttingDown = true;
  public lifecycle = new AbortController();
  public pending = new Set<Promise<void>>();
  private deliveredCompletionIds = new Set<string>();
  private inFlightCompletionIds = new Set<string>();
  public handoffDir = HANDOFF_DIR;
  private handoffWatcher: ReturnType<typeof setInterval> | undefined;
  private pendingSetups = new Set<AbortController>();
  private widgetTimer: ReturnType<typeof setInterval> | undefined;
  private pendingCompletions: Array<{
    message: string;
    completion: "queue" | "continue";
    expectedGeneration: number;
    originLeafId: string | null;
    triggerTurn: boolean;
    completionId?: string;
    displayMessage?: string;
    details?: unknown;
  }> = [];

  constructor(public pi: ExtensionAPI) {}

  public init() {
    // Ensure storage roots are private before anything writes into them.
    ensurePrivateDir(SUBAGENT_DIR);
    ensurePrivateDir(SUBAGENT_SESSION_DIR);

    for (const record of Object.values(readIndex())) {
      if (record.state === "running" && !processIsAlive(record.ownerPid)) {
        record.state = "interrupted";
        record.updatedAt = new Date().toISOString();
        saveRecord(record);
      }
    }

    this.registerMessageRenderer();
    this.registerLifecycleEvents();
  }

  private registerMessageRenderer() {
    this.pi.registerMessageRenderer(
      "pi-subagent-result",
      (message, options, theme) => {
        const text = sanitizeTerminalOutput(
          displayText(message.content, message.details),
        );
        if (!text.trim()) return undefined;

        const lines = text.trim().split("\n");
        const firstLine = lines[0] ?? "";
        const isError = [
          "Background subagent timed out",
          "Background subagent was stopped",
          "Background subagent failed",
        ].some((prefix) => firstLine.startsWith(prefix));

        const bgFn = isError
          ? (s: string) => theme.bg("toolErrorBg", s)
          : (s: string) => theme.bg("toolSuccessBg", s);

        const titleColor = isError ? "error" : "accent";
        const headerText = theme.fg(titleColor, theme.bold(firstLine));

        const bodyText = lines.slice(1).join("\n").trim();
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(headerText, 0, 0));

        if (bodyText) {
          if (options.expanded) {
            box.addChild(createMarkdownComponent(bodyText));
          } else {
            const bodyLines = bodyText.split("\n");
            const preview = bodyLines.slice(0, 8).join("\n");
            const hidden = Math.max(0, bodyLines.length - 8);
            const hint =
              hidden > 0 ? `\n\n_${hidden} more lines (expand to view)_` : "";
            box.addChild(createMarkdownComponent(preview + hint));
          }
        }
        return box;
      },
    );
  }

  private registerLifecycleEvents() {
    this.pi.on("session_start", (_e, ctx) => {
      this.generation++;
      this.shuttingDown = false;
      this.lifecycle = new AbortController();
      this.deliveredCompletionIds.clear();
      this.inFlightCompletionIds.clear();
      for (const job of this.jobs.values()) {
        job.expectedGeneration = this.generation;
        job.originSessionFile = ctx.sessionManager.getSessionFile() ?? "";
        job.originSessionId = ctx.sessionManager.getSessionId();
        job.handedOff = false;
        if (job.activity === "finishing (session reload)") {
          job.activity = undefined;
        }
      }
      this.drainHandoffs(ctx);
      this.flushPendingCompletions(ctx);
      this.syncStatus(ctx);
    });

    this.pi.on("before_agent_start", (_event, ctx) => {
      this.flushPendingCompletions(ctx);
    });

    this.pi.on("agent_settled", (_event, ctx) => {
      this.flushPendingCompletions(ctx);
    });

    this.pi.on("message_end", (event) => {
      if (event.message.role !== "custom") return;
      const ids = (
        event.message.details as { completionIds?: unknown } | undefined
      )?.completionIds;
      if (!Array.isArray(ids)) return;
      for (const id of ids) {
        if (typeof id !== "string") continue;
        this.inFlightCompletionIds.delete(id);
        this.deliveredCompletionIds.add(id);
      }
    });

    this.pi.on("session_tree", (_event, ctx) => {
      this.flushPendingCompletions(ctx);
    });

    this.pi.on("session_shutdown", async (event, ctx) => {
      this.shuttingDown = true;
      this.lifecycle.abort();
      this.inFlightCompletionIds.clear();
      this.deliveredCompletionIds.clear();
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      if (event.reason === "quit") {
        for (const [pid, job] of this.jobs) {
          try {
            job.record = {
              ...this.currentRecord(job),
              state: "interrupted",
              updatedAt: new Date().toISOString(),
              durationSec: Math.round((Date.now() - job.startedAt) / 1000),
            };
            saveRecord(job.record);
          } catch (error) {
            console.warn(
              `Could not persist interrupted subagent ${pid}:`,
              error,
            );
          } finally {
            this.killJob(pid);
          }
        }
        let shutdownTimeout: ReturnType<typeof setTimeout> | undefined;
        let shutdownTimedOut = false;
        const timeoutPromise = new Promise<void>((resolve) => {
          shutdownTimeout = setTimeout(() => {
            shutdownTimedOut = true;
            resolve();
          }, 10000);
          shutdownTimeout.unref();
        });
        try {
          await Promise.race([
            Promise.allSettled([...this.pending]),
            timeoutPromise,
          ]);
          if (shutdownTimedOut) {
            for (const [pid, job] of this.jobs) {
              try {
                job.forceCleanup();
              } catch {}
              this.jobs.delete(pid);
            }
          }
        } finally {
          if (shutdownTimeout) clearTimeout(shutdownTimeout);
        }
      } else {
        // Session replacement (reload/new/resume/fork/clone): keep the
        // child running in this runtime's closure and hand its result to
        // the next runtime of the origin session through the handoff dir.
        this.handoffActiveJobs(ctx);
        this.startHandoffWatcher();
        process.on("exit", () => {
          for (const job of this.jobs.values()) job.controller.abort();
        });
      }
      this.currentCtx = undefined;
    });
  }

  public syncStatus(ctx?: ExtensionContext) {
    if (this.shuttingDown) {
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }
    const active = this.currentCtx ?? ctx;
    if (!active) return;

    const activeJobs = Array.from(this.jobs.values());
    if (activeJobs.length === 0) {
      active.ui.setWidget("pi-subagents", undefined);
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }

    active.ui.setWidget(
      "pi-subagents",
      (_tui, theme) => {
        const frame =
          BRAILLE[Math.floor(Date.now() / WIDGET_REFRESH_MS) % BRAILLE.length];
        const bColor = (str: string) => theme.fg("dim", str);
        return {
          render(width: number) {
            const count = activeJobs.length;
            const innerWidth = Math.max(10, width - 2);
            const title = ` Subagents (${count}) `;
            const topFillLen = Math.max(0, innerWidth - visibleWidth(title));
            const top = truncateToWidth(
              bColor("╭") +
                theme.fg("accent", theme.bold(title)) +
                bColor("─".repeat(topFillLen)) +
                bColor("╮"),
              width,
            );

            const maxVisible = 3;
            const overflow = count > maxVisible;
            const visibleJobs = activeJobs.slice(0, overflow ? 2 : 3);

            const jobLines = visibleJobs.map((job) => {
              const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
              const stopping = job.stopping === true;
              const icon = theme.fg(
                stopping ? "warning" : "success",
                stopping ? "◐" : "●",
              );
              const progress = job.activity
                ? `, ${truncateToWidth(sanitizeTerminalOutput(job.activity), 24)}`
                : "";
              const badgeText = job.session.model
                ? sanitizeTerminalOutput(
                    `${job.session.model.id}:${job.session.thinkingLevel}`,
                  )
                : sanitizeTerminalOutput(job.record.model);
              const queueTag = job.completion === "queue" ? " Q" : "";
              const badge = ` [${badgeText}${queueTag}]`;
              const prefix = ` ${icon} `;
              const state = stopping ? "stopping" : "running";
              const meta = `${badge} ${theme.fg("dim", `(${state}, ${elapsed}s${progress})`)}`;
              const availForCmd = Math.max(
                0,
                innerWidth - visibleWidth(prefix) - visibleWidth(meta),
              );
              const command = sanitizeTerminalOutput(job.command);
              const truncatedCmd =
                visibleWidth(command) > availForCmd
                  ? truncateToWidth(command, availForCmd)
                  : command;
              const content = `${prefix}${truncatedCmd}${meta}`;
              const fill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(content)),
              );
              return (
                bColor("│") +
                truncateToWidth(content + fill, innerWidth) +
                bColor("│")
              );
            });

            if (overflow) {
              const hidden = count - 2;
              const content = ` ${theme.fg("accent", frame)} ${theme.fg("dim", `+${hidden} more running...`)}`;
              const fill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(content)),
              );
              jobLines.push(
                bColor("│") +
                  truncateToWidth(content + fill, innerWidth) +
                  bColor("│"),
              );
            }

            const bottom = bColor("╰" + "─".repeat(innerWidth) + "╯");
            return [top, ...jobLines, bottom].map((line) =>
              truncateToWidth(line, width),
            );
          },
          invalidate() {},
        };
      },
      { placement: "aboveEditor" },
    );

    if (!this.widgetTimer) {
      this.widgetTimer = setInterval(
        () => this.syncStatus(),
        WIDGET_REFRESH_MS,
      );
    }
  }

  private hasPersistedCompletion(ids: string[], ctx: ExtensionContext) {
    if (!ids.length) return false;
    const idSet = new Set(ids);
    try {
      return ctx.sessionManager.getEntries().some((entry) => {
        if ((entry as { type?: string }).type !== "message") return false;
        const details = (
          (entry as { message?: { details?: unknown } }).message ?? {}
        ).details;
        const completionIds =
          details && typeof details === "object"
            ? (details as { completionIds?: unknown }).completionIds
            : undefined;
        return (
          Array.isArray(completionIds) &&
          completionIds.some((id) => typeof id === "string" && idSet.has(id))
        );
      });
    } catch {
      return false;
    }
  }

  public handoffPathFor(completionId?: string) {
    if (!completionId) return undefined;
    const path = join(this.handoffDir, `${completionId}.json`);
    return existsSync(path) ? path : undefined;
  }

  public writeHandoffResult(
    path: string,
    result: NonNullable<HandoffEntry["result"]>,
  ) {
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as HandoffEntry;
      writeFileSync(path, JSON.stringify({ ...entry, result }, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      console.warn("Could not persist handoff result:", error);
    }
  }

  private ensureHandoffDir() {
    try {
      mkdirSync(this.handoffDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      console.warn("Could not create handoff directory:", error);
    }
  }

  private handoffActiveJobs(ctx: ExtensionContext) {
    this.ensureHandoffDir();
    for (const job of this.jobs.values()) {
      if (!job.completionId) {
        job.controller.abort();
        continue;
      }
      const entry: HandoffEntry = {
        v: 1,
        pid: job.pid,
        sessionId: job.sessionId,
        sessionFile: job.originSessionFile,
        parentSessionId: job.originSessionId,
        originLeafId: job.originLeafId,
        startedAt: job.startedAt,
        completion: job.completion ?? "queue",
        completionId: job.completionId,
        expectedGeneration: job.expectedGeneration,
        command: job.command,
      };
      try {
        writeFileSync(
          join(this.handoffDir, `${job.completionId}.json`),
          JSON.stringify(entry, null, 2),
          { mode: 0o600 },
        );
      } catch (error) {
        console.warn("Could not persist handoff entry:", error);
      }
    }
  }

  private stopRequested(completionId: string) {
    return existsSync(join(this.handoffDir, `${completionId}.stop`));
  }

  private writeStopMarker(completionId: string) {
    try {
      writeFileSync(join(this.handoffDir, `${completionId}.stop`), "", {
        mode: 0o600,
      });
    } catch (error) {
      console.warn("Could not persist stop marker:", error);
    }
  }

  private startHandoffWatcher() {
    if (this.handoffWatcher) return;
    this.handoffWatcher = setInterval(() => {
      for (const job of this.jobs.values()) {
        if (
          job.completionId &&
          this.stopRequested(job.completionId) &&
          !job.controller.signal.aborted
        ) {
          job.stoppedManually = true;
          job.stopping = true;
          job.controller.abort();
        }
      }
      if (this.currentCtx) this.drainHandoffs(this.currentCtx);
      if (this.jobs.size === 0 && this.handoffWatcher) {
        clearInterval(this.handoffWatcher);
        this.handoffWatcher = undefined;
      }
    }, 500);
    this.handoffWatcher.unref?.();
  }

  private drainHandoffs(ctx: ExtensionContext) {
    this.ensureHandoffDir();
    let restored = 0;
    for (const name of readdirSync(this.handoffDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.handoffDir, name);
      try {
        const entry = JSON.parse(readFileSync(path, "utf8")) as HandoffEntry;
        if (!entry.result && Date.now() - entry.startedAt > 10 * 60 * 1000) {
          rmSync(path, { force: true });
          continue;
        }
        const currentFile = ctx.sessionManager.getSessionFile() ?? "";
        const currentId = ctx.sessionManager.getSessionId();
        if (
          entry.sessionFile !== currentFile &&
          !(entry.parentSessionId && entry.parentSessionId === currentId)
        )
          continue;
        if (entry.result) {
          const stopped = this.stopRequested(entry.completionId);
          this.pendingCompletions.push({
            message: entry.result.message,
            completion: stopped ? "queue" : entry.completion,
            expectedGeneration: this.generation,
            originLeafId: entry.originLeafId,
            triggerTurn: entry.result.triggerTurn,
            completionId: entry.completionId,
            displayMessage: entry.result.displayMessage,
            details: entry.result.details,
          });
          this.jobs.delete(entry.pid);
          rmSync(path, { force: true });
          if (stopped)
            rmSync(join(this.handoffDir, `${entry.completionId}.stop`), {
              force: true,
            });
          continue;
        }
        if (this.jobs.has(entry.pid) && !this.jobs.get(entry.pid)?.handedOff) {
          continue;
        }
        const stopped = entry.completionId
          ? this.stopRequested(entry.completionId)
          : false;
        if (stopped) {
          if (entry.sessionId) {
            const durable = readIndex();
            if (durable[entry.sessionId]) {
              durable[entry.sessionId].state = "interrupted";
              durable[entry.sessionId].updatedAt = new Date().toISOString();
              saveRecord(durable[entry.sessionId]);
            }
          }
          rmSync(path, { force: true });
          if (entry.completionId)
            rmSync(join(this.handoffDir, `${entry.completionId}.stop`), {
              force: true,
            });
          this.jobs.delete(entry.pid);
          continue;
        }
        const record =
          (entry.sessionId ? readIndex()[entry.sessionId] : undefined) ??
          ({
            sessionId: entry.sessionId ?? `handoff-${entry.pid}`,
            cwd: ctx.cwd,
            sessionFile: "",
            model: "unknown",
            label: entry.command ?? `subagent ${entry.pid}`,
            createdAt: new Date(entry.startedAt).toISOString(),
            updatedAt: new Date().toISOString(),
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
            inheritedTools: [],
            context: "project",
          } as SubagentRecord);
        const job: SubagentJob = {
          pid: entry.pid,
          command: entry.command ?? `subagent ${entry.pid}`,
          startedAt: entry.startedAt,
          sessionId: entry.sessionId ?? `handoff-${entry.pid}`,
          controller: new AbortController(),
          completionId: entry.completionId,
          forceCleanup: () => {},
          session: HANDED_OFF_SESSION,
          activity: "finishing (session reload)",
          baseline: HANDED_OFF_SESSION.getSessionStats(),
          record,
          toolFailures: 0,
          completion: entry.completion,
          originLeafId: entry.originLeafId,
          expectedGeneration: entry.expectedGeneration,
          originSessionFile: entry.sessionFile,
          originSessionId: entry.parentSessionId ?? "",
          handedOff: true,
        };
        this.jobs.set(entry.pid, job);
        restored++;
      } catch (error) {
        console.warn("Could not read handoff entry:", error);
      }
    }
    if (restored) this.startHandoffWatcher();
    this.flushPendingCompletions(ctx);
  }

  private canDeliverToOrigin(
    originLeafId: string | null,
    ctx: ExtensionContext,
  ) {
    if (originLeafId === null) return ctx.sessionManager.getLeafId() === null;
    return ctx.sessionManager
      .getBranch()
      .some((entry) => entry.id === originLeafId);
  }

  private sendCompletionMessage(
    message: string,
    completion: "queue" | "continue",
    originLeafId: string | null,
    triggerTurn: boolean,
    ctx: ExtensionContext,
    displayMessage?: string,
    details?: unknown,
    completionIds: string[] = [],
  ) {
    if (!this.canDeliverToOrigin(originLeafId, ctx)) return;
    const idle = ctx.isIdle();
    if (!triggerTurn && !idle) throw new Error("Parent turn is still active");
    const options =
      completion === "queue"
        ? idle
          ? { triggerTurn: false as const }
          : { deliverAs: "followUp" as const }
        : { deliverAs: "steer" as const, triggerTurn };
    this.pi.sendMessage(
      {
        customType: "pi-subagent-result",
        content: sanitizeTerminalOutput(message),
        display: true,
        details: {
          ...(details && typeof details === "object" ? details : {}),
          completionIds,
          ...(displayMessage
            ? { displayText: sanitizeTerminalOutput(displayMessage) }
            : {}),
        },
      },
      options,
    );
  }

  private flushPendingCompletions(ctx: ExtensionContext) {
    this.currentCtx = ctx;
    const ready: typeof this.pendingCompletions = [];
    for (const item of this.pendingCompletions.splice(0)) {
      if (this.shuttingDown || this.generation !== item.expectedGeneration) {
        if (!this.shuttingDown)
          console.warn(
            "Dropping subagent completion from an earlier session generation",
          );
        continue;
      }
      if (
        !this.canDeliverToOrigin(item.originLeafId, ctx) ||
        (!ctx.isIdle() && (item.completion === "queue" || !item.triggerTurn))
      ) {
        this.pendingCompletions.push(item);
        continue;
      }
      ready.push(item);
    }

    const queued = ready.filter((item) => item.completion === "queue");
    const batches: Array<
      (typeof queued)[number] & { batchedItems: typeof queued }
    > = [];
    const byOrigin = new Map<string | null, typeof this.pendingCompletions>();
    for (const item of queued) {
      const group = byOrigin.get(item.originLeafId) ?? [];
      group.push(item);
      byOrigin.set(item.originLeafId, group);
    }
    for (const group of byOrigin.values()) {
      let chunk: typeof this.pendingCompletions = [];
      const flushChunk = () => {
        if (!chunk.length) return;
        const results = chunk.map((item) => {
          try {
            return JSON.parse(item.message);
          } catch {
            return item.message;
          }
        });
        batches.push({
          ...chunk[0],
          message:
            chunk.length === 1
              ? chunk[0].message
              : JSON.stringify({
                  v: 1,
                  type: "subagent",
                  event: "batch",
                  results,
                }),
          displayMessage: chunk
            .map((item) => item.displayMessage ?? item.message)
            .join("\n\n"),
          completionId: undefined,
          details: {
            count: chunk.length,
            completionIds: chunk.flatMap((entry) =>
              entry.completionId ? [entry.completionId] : [],
            ),
          },
          batchedItems: chunk,
        });
        chunk = [];
      };
      for (const item of group) {
        const candidate = [...chunk, item].map((entry) => {
          try {
            return JSON.parse(entry.message);
          } catch {
            return entry.message;
          }
        });
        if (
          chunk.length &&
          Buffer.byteLength(
            JSON.stringify({
              v: 1,
              type: "subagent",
              event: "batch",
              results: candidate,
            }),
          ) > MODEL_OUTPUT_MAX_BYTES
        )
          flushChunk();
        chunk.push(item);
      }
      flushChunk();
    }
    const deliver = [
      ...ready
        .filter((item) => item.completion === "continue")
        .map((item) => ({ ...item, batchedItems: [item] })),
      ...batches,
    ];

    for (const item of deliver) {
      try {
        const ids = item.batchedItems.flatMap((entry) =>
          entry.completionId ? [entry.completionId] : [],
        );
        for (const id of ids) this.inFlightCompletionIds.add(id);
        this.sendCompletionMessage(
          item.message,
          item.completion,
          item.originLeafId,
          item.triggerTurn,
          ctx,
          item.displayMessage,
          item.details,
          ids,
        );
      } catch (error) {
        const ids = item.batchedItems.flatMap((entry) =>
          entry.completionId ? [entry.completionId] : [],
        );
        for (const id of ids) this.inFlightCompletionIds.delete(id);
        if (this.hasPersistedCompletion(ids, ctx)) {
          for (const id of ids) this.deliveredCompletionIds.add(id);
        } else {
          this.pendingCompletions.push(...item.batchedItems);
        }
        console.warn("Could not deliver pending subagent result:", error);
      }
    }
  }

  public guard(expectedGeneration: number) {
    if (
      this.shuttingDown ||
      this.generation !== expectedGeneration ||
      this.lifecycle.signal.aborted
    )
      throw new Error("Parent session ended during subagent setup");
  }

  public track(done: Promise<void>) {
    this.pending.add(done);
    void done.finally(() => this.pending.delete(done)).catch(() => {});
    return done;
  }

  public deliverCompletion(
    message: string,
    completion: "queue" | "continue",
    expectedGeneration: number,
    originLeafId: string | null,
    triggerTurn = true,
    completionId?: string,
    displayMessage?: string,
    details?: unknown,
  ) {
    if (completionId) {
      const handoffPath = this.handoffPathFor(completionId);
      if (handoffPath) {
        try {
          rmSync(handoffPath, { force: true });
        } catch {}
      }
      const stopPath = join(this.handoffDir, `${completionId}.stop`);
      if (existsSync(stopPath)) {
        try {
          rmSync(stopPath, { force: true });
        } catch {}
      }
    }
    if (this.shuttingDown || this.generation !== expectedGeneration) return;
    if (
      completionId &&
      (this.deliveredCompletionIds.has(completionId) ||
        this.inFlightCompletionIds.has(completionId) ||
        this.pendingCompletions.some(
          (item) => item.completionId === completionId,
        ))
    )
      return;
    const active = this.currentCtx;
    if (
      !active ||
      (!active.isIdle() && (completion === "queue" || !triggerTurn)) ||
      !this.canDeliverToOrigin(originLeafId, active)
    ) {
      this.pendingCompletions.push({
        message,
        completion,
        expectedGeneration,
        originLeafId,
        triggerTurn,
        completionId,
        displayMessage,
        details,
      });
      return;
    }
    try {
      if (completionId) this.inFlightCompletionIds.add(completionId);
      this.sendCompletionMessage(
        message,
        completion,
        originLeafId,
        triggerTurn,
        active,
        displayMessage,
        details,
        completionId ? [completionId] : [],
      );
    } catch (error) {
      if (completionId) this.inFlightCompletionIds.delete(completionId);
      if (completionId && this.hasPersistedCompletion([completionId], active)) {
        this.deliveredCompletionIds.add(completionId);
      } else {
        this.pendingCompletions.push({
          message,
          completion,
          expectedGeneration,
          originLeafId,
          triggerTurn,
          completionId,
          displayMessage,
          details,
        });
      }
      console.warn("Could not deliver subagent result:", error);
    }
  }

  public killJob(pid: number): boolean {
    const job = this.jobs.get(pid);
    if (!job || job.controller.signal.aborted) return false;
    job.stoppedManually = true;
    job.stopping = true;
    job.controller.abort();
    if (job.completionId) {
      this.writeStopMarker(job.completionId);
    }
    if (job.handedOff) {
      try {
        job.record = {
          ...job.record,
          state: "interrupted",
          updatedAt: new Date().toISOString(),
          durationSec: Math.round((Date.now() - job.startedAt) / 1000),
        };
        saveRecord(job.record);
      } catch {}
      this.jobs.delete(pid);
    }
    return true;
  }

  public trackSetup(controller: AbortController) {
    this.pendingSetups.add(controller);
    return () => this.pendingSetups.delete(controller);
  }

  public killAllJobs(): number {
    let stopped = 0;
    for (const pid of this.jobs.keys()) {
      if (this.killJob(pid)) stopped++;
    }
    for (const controller of this.pendingSetups) {
      if (!controller.signal.aborted) {
        controller.abort();
        stopped++;
      }
    }
    return stopped;
  }

  public currentRecord(job: SubagentJob): SubagentRecord {
    const stats = job.session.getSessionStats();
    return {
      ...job.record,
      ...(job.session.model
        ? {
            model: `${job.session.model.provider}/${job.session.model.id}`,
            thinking: job.session.thinkingLevel,
          }
        : {}),
      turns: stats.assistantMessages - job.baseline.assistantMessages,
      toolCount: stats.toolCalls - job.baseline.toolCalls,
      toolFailures: job.toolFailures,
      usage: usageSince(stats, job.baseline),
    };
  }

  public async manageJobs(ctx: ExtensionContext) {
    if (this.jobs.size === 0)
      return ctx.ui.notify("No subagents running", "info");
    const choice = await ctx.ui.select("Select subagent to stop:", [
      "Cancel",
      "Stop all",
      ...Array.from(
        this.jobs.values(),
        (job) =>
          `[${job.pid}] ${job.command} [session: ${job.sessionId.slice(0, 8)}] (${Math.round((Date.now() - job.startedAt) / 1000)}s)`,
      ),
    ]);
    if (choice === "Stop all") {
      const stopped = this.killAllJobs();
      ctx.ui.notify(
        `Stopped ${stopped} subagent${stopped === 1 ? "" : "s"}`,
        "info",
      );
      this.syncStatus(ctx);
      return;
    }
    const pid = Number(choice?.match(/\[(-?\d+)\]/)?.[1]);
    if (choice !== "Cancel" && Number.isInteger(pid) && this.killJob(pid)) {
      ctx.ui.notify(`Stopped subagent ${pid}`, "info");
      this.syncStatus(ctx);
    }
  }
}
