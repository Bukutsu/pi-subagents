import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, truncateTail } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  type SelectItem,
  SelectList,
  Text,
  visibleWidth,
  truncateToWidth,
} from "@earendil-works/pi-tui";

import {
  SUBAGENT_DIR,
  SUBAGENT_SESSION_DIR,
  type SubagentJob,
  type SubagentRecord,
} from "./types.js";

declare global {
  var __PI_SUBAGENTS_ACTIVE_JOBS__: Map<number, SubagentJob> | undefined;
  var __PI_SUBAGENTS_PENDING_SETUPS__: Set<AbortController> | undefined;
}

function getGlobalActiveJobs(): Map<number, SubagentJob> {
  return (globalThis.__PI_SUBAGENTS_ACTIVE_JOBS__ ??= new Map<
    number,
    SubagentJob
  >());
}

function getGlobalPendingSetups(): Set<AbortController> {
  return (globalThis.__PI_SUBAGENTS_PENDING_SETUPS__ ??= new Set());
}

import {
  createMarkdownComponent,
  displayText,
  ensurePrivateDir,
  getModelOutputBudget,
  processIsAlive,
  readIndex,
  sanitizeTerminalOutput,
  saveRecord,
  usageSince,
} from "./utils.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_REFRESH_MS = 200;

/** Shrink an oversized result to the budget via the batch summarizer. */
export function shrinkToBudget(message: string, maxBytes: number): string {
  return Buffer.byteLength(message) <= maxBytes
    ? message
    : buildBatchMessage([{ message }], maxBytes).message;
}

function parseCompletionMessage(message: string): unknown {
  try {
    return JSON.parse(message);
  } catch {
    return message;
  }
}

function summarizeCompletion(value: unknown): unknown {
  if (typeof value !== "object" || value === null)
    return { outputTruncated: true };
  const sessionId =
    "sessionId" in value && typeof value.sessionId === "string"
      ? value.sessionId
      : undefined;
  const state =
    "state" in value && typeof value.state === "string"
      ? value.state
      : undefined;
  // Keep the retained-log pointer and a capped reason so a summarized
  // oversized result stays recoverable.
  const logPath =
    "logPath" in value && typeof value.logPath === "string"
      ? value.logPath
      : undefined;
  const reason =
    "reason" in value && typeof value.reason === "string"
      ? value.reason.slice(0, 200)
      : undefined;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(state ? { state } : {}),
    ...(logPath ? { logPath } : {}),
    ...(reason ? { reason } : {}),
    outputTruncated: true,
  };
}

function buildBatchMessage(
  items: Array<{ message: string }>,
  maxBytes = getModelOutputBudget(),
): {
  message: string;
  deliveredIndexes: number[];
  omittedIndexes: number[];
} {
  const results: unknown[] = [];
  const deliveredIndexes: number[] = [];
  const omittedIndexes: number[] = [];
  for (const [index, item] of items.entries()) {
    const value = parseCompletionMessage(item.message);
    const candidate = {
      v: 1,
      type: "subagent",
      event: "batch",
      results: [...results, value],
    };
    if (Buffer.byteLength(JSON.stringify(candidate)) <= maxBytes) {
      results.push(value);
      deliveredIndexes.push(index);
      continue;
    }
    const summary = summarizeCompletion(value);
    const summarizedCandidate = {
      ...candidate,
      results: [...results, summary],
    };
    if (Buffer.byteLength(JSON.stringify(summarizedCandidate)) <= maxBytes) {
      results.push(summary);
      deliveredIndexes.push(index);
    } else omittedIndexes.push(index);
  }

  const encode = () =>
    JSON.stringify({
      v: 1,
      type: "subagent",
      event: "batch",
      results,
      ...(omittedIndexes.length ? { omitted: omittedIndexes.length } : {}),
    });
  let message = encode();
  while (Buffer.byteLength(message) > maxBytes && deliveredIndexes.length > 0) {
    results.pop();
    const index = deliveredIndexes.pop();
    if (index !== undefined) omittedIndexes.push(index);
    message = encode();
  }
  return { message, deliveredIndexes, omittedIndexes };
}

export class SubagentManager {
  public jobs: Map<number, SubagentJob> = getGlobalActiveJobs();
  public nextVirtualPid = 1;

  public activeCount(): number {
    return this.jobs.size + this.pendingSetups.size;
  }
  public currentCtx: ExtensionContext | undefined;
  public generation = 0;
  public shuttingDown = true;
  public lifecycle = new AbortController();
  public pending = new Set<Promise<unknown>>();
  private deliveredCompletionIds = new Set<string>();
  private inFlightCompletionIds = new Set<string>();
  private pendingSetups: Set<AbortController> = getGlobalPendingSetups();
  private widgetTimer: ReturnType<typeof setInterval> | undefined;
  private pendingCompletions: Array<{
    message: string;
    completion: "queue" | "continue";
    expectedGeneration: number;
    originLeafId: string | null;
    originSessionFile?: string;
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
    // Block session replacement when subagents are running.
    const blockWhileActive = (action: string) => {
      return (_event: unknown, ctx: ExtensionContext) => {
        if (this.activeCount() > 0) {
          ctx.ui.notify(
            `Cannot ${action} while ${this.activeCount()} subagent${this.activeCount() === 1 ? "" : "s"} running. Stop them with /subagents first.`,
            "error",
          );
          return { cancel: true };
        }
      };
    };
    this.pi.on("session_before_switch", blockWhileActive("switch sessions"));
    this.pi.on("session_before_fork", blockWhileActive("fork session"));
    this.pi.on("session_before_compact", blockWhileActive("compact session"));
    this.pi.on(
      "session_before_tree",
      blockWhileActive("navigate session tree"),
    );

    this.pi.on("session_start", (_e, ctx) => {
      this.generation++;
      this.shuttingDown = false;
      this.lifecycle = new AbortController();
      this.deliveredCompletionIds.clear();
      this.inFlightCompletionIds.clear();
      const sessionFile = this.sessionFile(ctx);
      this.pendingCompletions = this.pendingCompletions.filter(
        (item) =>
          !item.originSessionFile || item.originSessionFile === sessionFile,
      );
      for (const item of this.pendingCompletions) {
        item.expectedGeneration = this.generation;
      }
      this.flushPendingCompletions(ctx);
      this.syncStatus(ctx);
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

    this.pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason !== "quit") {
        if (this.activeCount() > 0) {
          const action =
            event.reason === "reload" ? "Reload" : "Session replacement";
          ctx.ui.notify(
            `${action} is waiting for ${this.activeCount()} running subagent${this.activeCount() === 1 ? "" : "s"}. Stop them with /subagents or wait for them to finish.`,
            "info",
          );
          // Setups have no run-phase deadline; cancel them so a hung setup
          // cannot stall the wait indefinitely.
          for (const controller of this.pendingSetups) controller.abort();
          const deadline = Date.now() + 10000;
          while (this.activeCount() > 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          if (this.activeCount() === 0) return;
          ctx.ui.notify(
            `${action} timed out waiting for subagents; stopping them.`,
            "warning",
          );
        }
      }
      this.shuttingDown = true;
      this.lifecycle.abort();
      this.inFlightCompletionIds.clear();
      this.deliveredCompletionIds.clear();
      this.pendingCompletions = [];
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
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
          console.warn(`Could not persist interrupted subagent ${pid}:`, error);
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
      try {
        active.ui.setWidget("pi-subagents", undefined);
      } catch {}
      if (this.widgetTimer) {
        clearInterval(this.widgetTimer);
        this.widgetTimer = undefined;
      }
      return;
    }

    try {
      active.ui.setWidget(
        "pi-subagents",
        (_tui, theme) => {
          const frame =
            BRAILLE[
              Math.floor(Date.now() / WIDGET_REFRESH_MS) % BRAILLE.length
            ];
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
              const hintContent = ` ${theme.fg("dim", "↳ /subagents to manage")}`;
              const hintFill = " ".repeat(
                Math.max(0, innerWidth - visibleWidth(hintContent)),
              );
              const hint =
                bColor("│") +
                truncateToWidth(hintContent + hintFill, innerWidth) +
                bColor("│");
              return [top, ...jobLines, hint, bottom].map((line) =>
                truncateToWidth(line, width),
              );
            },
            invalidate() {},
          };
        },
        { placement: "aboveEditor" },
      );
    } catch {
      // Ignored if active context is stale or being replaced
    }

    if (!this.widgetTimer) {
      this.widgetTimer = setInterval(
        () => this.syncStatus(),
        WIDGET_REFRESH_MS,
      );
      this.widgetTimer.unref?.();
    }
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
    if (!triggerTurn && !idle && completion !== "queue")
      throw new Error("Parent turn is still active");
    const options =
      completion === "queue"
        ? idle
          ? // Parent is idle: honor triggerTurn so finished background work
            // starts a turn instead of piling up until the next user prompt.
            { triggerTurn }
          : { deliverAs: "followUp" as const, triggerTurn: false as const }
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
    const batchBudget = this.outputBudget(ctx);
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
        // Requeueing busy items here is deliberate: pi's deliverAs:"followUp"
        // only parks when triggerTurn !== false, and queue completions send
        // triggerTurn:false to stay silent. Delegating the wait to pi would
        // append them mid-turn as an implicit steer instead.
        this.pendingCompletions.push(item);
        continue;
      }
      ready.push(item);
    }

    const queued = ready.filter((item) => item.completion === "queue");
    const continued = ready.filter((item) => item.completion === "continue");

    const batchItems = (
      items: typeof ready,
      completionMode: "queue" | "continue",
    ) => {
      const batches: Array<
        (typeof items)[number] & { batchedItems: typeof items }
      > = [];
      const byOrigin = new Map<string | null, typeof items>();
      for (const item of items) {
        const group = byOrigin.get(item.originLeafId) ?? [];
        group.push(item);
        byOrigin.set(item.originLeafId, group);
      }
      for (const group of byOrigin.values()) {
        const first = group[0];
        if (!first) continue;
        const built =
          group.length === 1 && Buffer.byteLength(first.message) <= batchBudget
            ? {
                message: first.message,
                deliveredIndexes: [0],
                omittedIndexes: [] as number[],
              }
            : buildBatchMessage(group, batchBudget);
        const deliveredItems = built.deliveredIndexes.map(
          (index) => group[index],
        );
        const omittedItems = built.omittedIndexes.map((index) => group[index]);
        this.pendingCompletions.push(...omittedItems);
        batches.push({
          ...first,
          completion: completionMode,
          message: built.message,
          displayMessage: truncateTail(
            deliveredItems
              .map((item) => item?.displayMessage ?? item?.message ?? "")
              .join("\n\n"),
            { maxBytes: batchBudget },
          ).content,
          completionId: undefined,
          details: {
            count: deliveredItems.length,
            ...(omittedItems.length ? { omitted: omittedItems.length } : {}),
            completionIds: deliveredItems.flatMap((entry) =>
              entry?.completionId ? [entry.completionId] : [],
            ),
          },
          batchedItems: deliveredItems,
        });
      }
      return batches;
    };

    const deliver = [
      ...batchItems(continued, "continue"),
      ...batchItems(queued, "queue"),
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
        this.pendingCompletions.push(...item.batchedItems);
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

  public track<T>(done: Promise<T>): Promise<T> {
    const untyped = done as Promise<unknown>;
    this.pending.add(untyped);
    void done.finally(() => this.pending.delete(untyped)).catch(() => {});
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
      this.queueCompletion(
        message,
        completion,
        expectedGeneration,
        originLeafId,
        triggerTurn,
        completionId,
        displayMessage,
        details,
      );
      return;
    }
    try {
      if (completionId) this.inFlightCompletionIds.add(completionId);
      // A child with a larger context window than the parent can produce a
      // result above the parent's delivery budget; shrink it through the
      // batch summarizer instead of sending an oversized payload.
      const outgoing = shrinkToBudget(message, this.outputBudget(active));
      this.sendCompletionMessage(
        outgoing,
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
      this.queueCompletion(
        message,
        completion,
        expectedGeneration,
        originLeafId,
        triggerTurn,
        completionId,
        displayMessage,
        details,
      );
      console.warn("Could not deliver subagent result:", error);
    }
  }

  private queueCompletion(
    message: string,
    completion: "queue" | "continue",
    expectedGeneration: number,
    originLeafId: string | null,
    triggerTurn: boolean,
    completionId?: string,
    displayMessage?: string,
    details?: unknown,
  ) {
    this.pendingCompletions.push({
      message,
      completion,
      expectedGeneration,
      originLeafId,
      originSessionFile: this.currentCtx
        ? this.sessionFile(this.currentCtx)
        : undefined,
      triggerTurn,
      completionId,
      displayMessage,
      details,
    });
  }

  private sessionFile(ctx: ExtensionContext): string | undefined {
    return (
      ctx as unknown as {
        sessionManager?: { getSessionFile?: () => string };
      }
    )?.sessionManager?.getSessionFile?.();
  }

  private outputBudget(ctx: ExtensionContext): number {
    return getModelOutputBudget(
      (ctx as unknown as { model?: { contextWindow?: number } })?.model,
    );
  }

  public killJob(pid: number): boolean {
    const job = this.jobs.get(pid);
    if (!job) return false;
    if (!job.controller.signal.aborted) {
      job.stoppedManually = true;
      job.stopping = true;
      job.controller.abort();
      this.pi.events?.emit("subagent:stop", {
        pid,
        sessionId: job.sessionId,
      });
    }
    return true;
  }

  public trackSetup(controller: AbortController) {
    this.pendingSetups.add(controller);
    return () => this.pendingSetups.delete(controller);
  }

  public killAllJobs(): number {
    let stopped = 0;
    for (const [pid, job] of this.jobs) {
      if (!job.controller.signal.aborted && this.killJob(pid)) stopped++;
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

    const jobItems = (): SelectItem[] =>
      Array.from(this.jobs.values(), (job) => {
        let description: string;
        try {
          const record = this.currentRecord(job);
          const elapsed = Math.round((Date.now() - job.startedAt) / 1000);
          const cost = record.usage.cost ? ` · $${record.usage.cost.toFixed(4)}` : "";
          description = sanitizeTerminalOutput(
            `${record.model}${record.thinking ? `:${record.thinking}` : ""} · ${elapsed}s · ${record.turns} turn${record.turns === 1 ? "" : "s"} · ${record.toolCount} tool${record.toolCount === 1 ? "" : "s"}${cost}${job.activity ? ` · ${sanitizeTerminalOutput(job.activity)}` : ""}`,
          );
        } catch {
          description = sanitizeTerminalOutput(job.record.model);
        }
        const icon = job.stopping ? "◐" : "●";
        const label = job.command.replace(/^Subagent: /, "");
        return { value: String(job.pid), label: `${icon} ${label}`, description };
      });

    const choice = await ctx.ui.custom<string | null>(
      (tui, theme, _keybindings, done) => {
        const container = new Container();
        container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
        container.addChild(
          new Text(
            theme.fg("accent", theme.bold(`Subagents (${this.jobs.size} running)`)),
            1,
            0,
          ),
        );
        const items: SelectItem[] = [
          ...jobItems(),
          { value: "all", label: "Stop all", description: "Cancel every running subagent" },
        ];
        const selectList = new SelectList(items, Math.min(items.length, 10), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => done(item.value);
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
        container.addChild(
          new Text(theme.fg("dim", "enter stop · esc cancel"), 1, 0),
        );
        container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
    );

    if (choice === null) return;
    if (choice === "all") {
      const stopped = this.killAllJobs();
      ctx.ui.notify(
        `Stopped ${stopped} subagent${stopped === 1 ? "" : "s"}`,
        "info",
      );
    } else {
      const pid = Number(choice);
      if (Number.isInteger(pid) && this.killJob(pid)) {
        ctx.ui.notify(`Stopped subagent ${pid}`, "info");
      }
    }
    this.syncStatus(ctx);
  }
}
