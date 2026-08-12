import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
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
import {
  createMarkdownComponent,
  ensurePrivateDir,
  extractTextContent,
  getScopedModels,
  processIsAlive,
  readIndex,
  sanitizeTerminalOutput,
  saveRecord,
  usageSince,
} from "./utils.js";

const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WIDGET_REFRESH_MS = 200;

// A bash call is a wait when any statement of the command chain is a bare
// sleep, a watch loop, or a loop body/loop construct that sleeps (statement
// splitting on `;` turns `while true; do sleep 1; done` into `while true`,
// `do sleep 1`, `done`, which the `do sleep` rule catches).
const WAITING_STATEMENT_RE = [
  /^sleep\s+\d+(?:\.\d+)?(?:s|m|h)?$/i,
  /^watch\s+/i,
  /^do\s+sleep\b/i,
  /^(?:while|until)\b[\s\S]*\bsleep\b/i,
  /^for\b[\s\S]*\bsleep\b/i,
];

/**
 * Blocks bash sleep/polling loops at the tool boundary. Subagent results are
 * delivered automatically, so waiting model calls waste turns.
 */
export function registerWaitBlocker(pi: ExtensionAPI) {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    const command = event.input.command ?? "";
    const statements = command.split(/(?:&&|\|\||;|\n|\||&)/);
    for (const raw of statements) {
      const statement = raw.trim();
      if (!statement) continue;
      if (WAITING_STATEMENT_RE.some((re) => re.test(statement))) {
        return {
          block: true,
          reason:
            "Do not use sleep or polling loops to wait for subagents; results arrive automatically when ready. Continue other work instead.",
        };
      }
    }
  });
}

export class SubagentManager {
  public jobs = new Map<number, SubagentJob>();
  public nextVirtualPid = 1;
  public currentCtx: ExtensionContext | undefined;
  public generation = 0;
  public shuttingDown = true;
  public lifecycle = new AbortController();
  public pending = new Set<Promise<void>>();
  private pendingSetups = new Set<AbortController>();
  private widgetTimer: ReturnType<typeof setInterval> | undefined;
  private pendingCompletions: Array<{
    message: string;
    completion: "queue" | "continue";
    expectedGeneration: number;
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
    registerWaitBlocker(this.pi);
  }

  private registerMessageRenderer() {
    this.pi.registerMessageRenderer(
      "pi-subagent-result",
      (message, options, theme) => {
        const text = sanitizeTerminalOutput(
          extractTextContent(message.content),
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
            box.addChild(createMarkdownComponent(bodyText, theme));
          } else {
            const bodyLines = bodyText.split("\n");
            const preview = bodyLines.slice(0, 8).join("\n");
            const hidden = Math.max(0, bodyLines.length - 8);
            const hint =
              hidden > 0 ? `\n\n_${hidden} more lines (expand to view)_` : "";
            box.addChild(createMarkdownComponent(preview + hint, theme));
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
      this.flushPendingCompletions(ctx);
      this.syncStatus(ctx);
    });

    this.pi.on("before_agent_start", (event, ctx) => {
      this.flushPendingCompletions(ctx);
      const scopedList = getScopedModels(ctx);
      if (scopedList.length > 0) {
        const modelsList = scopedList
          .map((s) => `\`${s.model.provider}/${s.model.id}\``)
          .join(", ");
        return {
          systemPrompt: `${event.systemPrompt}\n\nAvailable scoped subagent models: ${modelsList}`,
        };
      }
    });

    this.pi.on("session_shutdown", async () => {
      this.shuttingDown = true;
      this.lifecycle.abort();
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
          for (const job of this.jobs.values()) {
            try {
              job.forceDispose();
            } catch {}
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
              const icon = theme.fg("success", "●");
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
              const meta = `${badge} ${theme.fg("dim", `(running, ${elapsed}s${progress})`)}`;
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

  private sendCompletionMessage(
    message: string,
    completion: "queue" | "continue",
    ctx: ExtensionContext,
  ) {
    this.pi.sendMessage(
      {
        customType: "pi-subagent-result",
        content: sanitizeTerminalOutput(message),
        display: true,
      },
      completion === "queue"
        ? { deliverAs: "nextTurn" }
        : { deliverAs: "steer", triggerTurn: ctx.isIdle() },
    );
  }

  private flushPendingCompletions(ctx: ExtensionContext) {
    this.currentCtx = ctx;
    while (this.pendingCompletions.length > 0) {
      const item = this.pendingCompletions.shift()!;
      if (!this.shuttingDown && this.generation === item.expectedGeneration) {
        try {
          this.sendCompletionMessage(item.message, item.completion, ctx);
        } catch (error) {
          console.warn("Could not deliver pending subagent result:", error);
        }
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
  ) {
    if (this.shuttingDown || this.generation !== expectedGeneration) return;
    const active = this.currentCtx;
    if (!active) {
      this.pendingCompletions.push({
        message,
        completion,
        expectedGeneration,
      });
      return;
    }
    try {
      this.sendCompletionMessage(message, completion, active);
    } catch (error) {
      console.warn("Could not deliver subagent result:", error);
      this.pendingCompletions.push({
        message,
        completion,
        expectedGeneration,
      });
    }
  }

  public killJob(pid: number): boolean {
    const job = this.jobs.get(pid);
    if (!job || job.controller.signal.aborted) return false;
    job.stoppedManually = true;
    job.controller.abort();
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
