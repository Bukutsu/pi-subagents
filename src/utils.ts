import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionContext,
  SessionStats,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  type SubagentRecord,
} from "./types.js";

export function sanitizeTerminalOutput(value: string) {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "")
    .replace(/\u009d[^\u0007]*(?:\u0007|\u009c)/g, "")
    .replace(/\u009b[0-?]*[ -/]*[@-~]/g, "")
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0090-\u009f]/g,
      "",
    );
}

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c &&
      typeof c === "object" &&
      c.type === "text" &&
      typeof c.text === "string"
        ? c.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

export function createMarkdownComponent(text: string, theme: Theme) {
  const mdTheme = {
    heading: (s: string) => theme.fg("toolTitle", theme.bold(s)),
    link: (s: string) => theme.fg("accent", s),
    linkUrl: (s: string) => theme.fg("dim", s),
    code: (s: string) => theme.fg("accent", s),
    codeBlock: (s: string) => theme.fg("toolOutput", s),
    codeBlockBorder: (s: string) => theme.fg("dim", s),
    quote: (s: string) => theme.fg("muted", s),
    quoteBorder: (s: string) => theme.fg("dim", s),
    hr: (s: string) => theme.fg("dim", s),
    listBullet: (s: string) => theme.fg("accent", s),
    bold: (s: string) => theme.bold(s),
    italic: (s: string) => s,
    strikethrough: (s: string) => s,
    underline: (s: string) => s,
  };
  return new Markdown(text, 0, 0, mdTheme);
}

export function renderToolResult(
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean },
  theme: Theme,
  previewLines: number,
) {
  const text = sanitizeTerminalOutput(
    extractTextContent(result.content).trim(),
  );
  if (!text) return new Text("", 0, 0);
  if (options.expanded) return createMarkdownComponent(text, theme);
  const lines = text.split("\n");
  const preview = lines.slice(0, previewLines).join("\n");
  const hidden = lines.length - previewLines;
  const hint =
    hidden > 0 ? `\n${theme.fg("dim", `... (${hidden} more lines)`)}` : "";
  return createMarkdownComponent(preview + hint, theme);
}

const TERMINAL_STATES = [
  "finished",
  "failed",
  "stopped",
  "timed-out",
  "interrupted",
] as const;

export function isSubagentRecord(value: unknown): value is SubagentRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SubagentRecord>;
  const usage = record.usage;
  return (
    typeof record.sessionId === "string" &&
    /^[a-zA-Z0-9-]+$/.test(record.sessionId) &&
    typeof record.cwd === "string" &&
    typeof record.sessionFile === "string" &&
    typeof record.model === "string" &&
    (record.thinking === undefined || typeof record.thinking === "string") &&
    typeof record.label === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    (record.state === "running" ||
      TERMINAL_STATES.includes(
        record.state as (typeof TERMINAL_STATES)[number],
      )) &&
    typeof record.turns === "number" &&
    Number.isInteger(record.turns) &&
    record.turns >= 0 &&
    typeof record.toolCount === "number" &&
    Number.isInteger(record.toolCount) &&
    record.toolCount >= 0 &&
    typeof record.toolFailures === "number" &&
    Number.isInteger(record.toolFailures) &&
    record.toolFailures >= 0 &&
    !!usage &&
    typeof usage === "object" &&
    typeof usage.input === "number" &&
    typeof usage.output === "number" &&
    typeof usage.cacheRead === "number" &&
    typeof usage.cacheWrite === "number" &&
    typeof usage.total === "number" &&
    typeof usage.cost === "number" &&
    Array.isArray(record.inheritedTools) &&
    record.inheritedTools.every((tool) => typeof tool === "string") &&
    (record.durationSec === undefined ||
      (typeof record.durationSec === "number" && record.durationSec >= 0)) &&
    (record.branch === undefined || typeof record.branch === "string") &&
    (record.context === "project" || record.context === "fork") &&
    (record.ownerPid === undefined ||
      (typeof record.ownerPid === "number" && record.ownerPid > 0))
  );
}

export function readIndex(): Record<string, SubagentRecord> {
  const records: Record<string, SubagentRecord> = Object.create(null);
  if (!existsSync(SUBAGENT_INDEX)) return records;
  try {
    for (const entry of readdirSync(SUBAGENT_INDEX, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(
          readFileSync(join(SUBAGENT_INDEX, entry.name), "utf8"),
        ) as unknown;
        if (!isSubagentRecord(record)) throw new Error("invalid record");
        records[record.sessionId] = record;
      } catch (error) {
        console.warn(`Ignoring invalid subagent record ${entry.name}:`, error);
      }
    }
  } catch (error) {
    console.warn("Could not read subagent index directory:", error);
  }
  return records;
}

export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // tighten pre-existing dirs
}

export function saveRecord(record: SubagentRecord) {
  if (!/^[a-zA-Z0-9-]+$/.test(record.sessionId))
    throw new Error(`Invalid subagent session ID: ${record.sessionId}`);
  ensurePrivateDir(SUBAGENT_INDEX);
  const target = join(SUBAGENT_INDEX, `${record.sessionId}.json`);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      flush: true,
    });
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
}

export function usageSince(current: SessionStats, baseline: SessionStats) {
  return {
    input: (current.tokens?.input ?? 0) - (baseline.tokens?.input ?? 0),
    output: (current.tokens?.output ?? 0) - (baseline.tokens?.output ?? 0),
    cacheRead:
      (current.tokens?.cacheRead ?? 0) - (baseline.tokens?.cacheRead ?? 0),
    cacheWrite:
      (current.tokens?.cacheWrite ?? 0) - (baseline.tokens?.cacheWrite ?? 0),
    total: (current.tokens?.total ?? 0) - (baseline.tokens?.total ?? 0),
    cost: (current.cost ?? 0) - (baseline.cost ?? 0),
  };
}

export function sanitizeForkMessages(ctx: ExtensionContext) {
  const messages = buildSessionContext(ctx.sessionManager.getBranch()).messages;
  const resultIds = new Set(
    messages.flatMap((message) =>
      message.role === "toolResult" &&
      !["bg", "subagent"].includes(message.toolName)
        ? [message.toolCallId]
        : [],
    ),
  );
  const callIds = new Set<string>();
  const sanitized: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (
      message.role === "custom" &&
      message.customType === "pi-subagent-result"
    )
      continue;
    if (
      message.role === "compactionSummary" ||
      message.role === "branchSummary"
    ) {
      sanitized.push({
        role: "user",
        content: `Parent conversation summary:\n${message.summary}`,
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        sanitized.push({ ...message } as unknown as Record<string, unknown>);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const content = message.content.filter((part: any) => {
        if (part.type !== "toolCall") return true;
        if (["bg", "subagent"].includes(part.name) || !resultIds.has(part.id))
          return false;
        callIds.add(part.id);
        return true;
      });
      if (content.length)
        sanitized.push({
          ...message,
          content,
          usage: undefined,
        });
      continue;
    }
    if (message.role === "toolResult") {
      if (callIds.has(message.toolCallId))
        sanitized.push({ ...message, usage: undefined });
      continue;
    }
    sanitized.push({ ...message } as unknown as Record<string, unknown>);
  }
  return sanitized as any;
}

export function processIsAlive(pid?: number) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function acquireSessionLock(sessionId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId))
    throw new Error(`Invalid subagent session ID: ${sessionId}`);
  ensurePrivateDir(SUBAGENT_LOCKS);
  const lock = join(SUBAGENT_LOCKS, sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tmp = `${lock}.tmp-${randomUUID()}`;
      try {
        mkdirSync(tmp, { mode: 0o700 });
        writeFileSync(join(tmp, "owner"), String(process.pid), {
          mode: 0o600,
        });
        renameSync(tmp, lock);
      } catch (createError) {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {}
        throw createError;
      }
      return lock;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== "EEXIST" && err?.code !== "ENOTEMPTY") throw error;
      try {
        const ownerFile = join(lock, "owner");
        let owner = NaN;
        try {
          if (existsSync(ownerFile))
            owner = Number(readFileSync(ownerFile, "utf8"));
        } catch {}
        if (!Number.isNaN(owner) && processIsAlive(owner))
          throw new Error(
            `Subagent session ${sessionId} is already running in process ${owner}`,
          );
        const stale = `${lock}.stale-${randomUUID()}`;
        renameSync(lock, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (staleError: unknown) {
        const staleErr = staleError as NodeJS.ErrnoException;
        if (staleErr?.code === "ENOENT") {
          continue;
        }
        throw staleError;
      }
    }
  }
  throw new Error(`Could not acquire subagent session lock: ${sessionId}`);
}

export function getScopedModels(ctx: ExtensionContext) {
  // ctx.scopedModels is typed on ExtensionContext; the fallback keeps the
  // package usable against older pi runtimes that did not expose it.
  return ctx.scopedModels ?? [];
}

export function resolveSubagentCwd(parent: string, requested?: string) {
  // Models sometimes emit a leading @ in tool path arguments; strip it before
  // resolving (built-in tools follow the same convention).
  const target = resolve(parent, requested?.trim().replace(/^@/, "") || ".");
  let realTarget = target;
  try {
    realTarget = realpathSync(target);
  } catch {}
  if (!existsSync(realTarget))
    throw new Error(`cwd does not exist: ${realTarget}`);
  if (!statSync(realTarget).isDirectory())
    throw new Error(`cwd is not a directory: ${realTarget}`);
  return realTarget;
}
