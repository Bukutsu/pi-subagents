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
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildSessionContext,
  getMarkdownTheme,
  truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentToolResult,
  ExtensionContext,
  SessionStats,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import {
  HISTORIC_SUBAGENT_INDEX,
  HISTORIC_SUBAGENT_LOCKS,
  HISTORIC_SUBAGENT_SESSION_DIR,
  HISTORIC_SUBAGENT_WORKTREES,
  LEGACY_SUBAGENT_INDEX,
  LEGACY_SUBAGENT_LOCKS,
  LEGACY_SUBAGENT_SESSION_DIR,
  LEGACY_SUBAGENT_WORKTREES,
  SUBAGENT_INDEX,
  SUBAGENT_LOCKS,
  SUBAGENT_SESSION_DIR,
  SUBAGENT_WORKTREES,
  type SubagentRecord,
} from "./types.js";

export const MODEL_OUTPUT_MAX_BYTES = 16 * 1024;
export const MODEL_OUTPUT_MAX_LINES = 400;
const FORK_CONTEXT_MAX_BYTES = 64 * 1024;

export function serializeModelJson(
  value: Record<string, unknown>,
  outputKey = "output",
) {
  let serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) <= MODEL_OUTPUT_MAX_BYTES)
    return serialized;

  const output = value[outputKey];
  if (typeof output === "string") {
    let low = 0;
    let high = output.length;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      const candidate = JSON.stringify({
        ...value,
        [outputKey]: length ? output.slice(-length) : "",
        outputTruncated: true,
      });
      if (Buffer.byteLength(candidate) <= MODEL_OUTPUT_MAX_BYTES) low = length;
      else high = length - 1;
    }
    serialized = JSON.stringify({
      ...value,
      [outputKey]: low ? output.slice(-low) : "",
      outputTruncated: true,
    });
    if (Buffer.byteLength(serialized) <= MODEL_OUTPUT_MAX_BYTES)
      return serialized;
  }

  return JSON.stringify({
    v: value.v ?? 1,
    type: value.type,
    event: value.event,
    action: value.action,
    truncated: true,
  });
}

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

export function displayText(content: unknown, details: unknown) {
  if (
    details &&
    typeof details === "object" &&
    typeof (details as { displayText?: unknown }).displayText === "string"
  )
    return (details as { displayText: string }).displayText;
  return extractTextContent(content);
}

export function createMarkdownComponent(text: string) {
  return new Markdown(text, 0, 0, getMarkdownTheme());
}

export function renderToolResult(
  result: AgentToolResult<unknown>,
  options: { expanded?: boolean },
  theme: Theme,
  previewLines: number,
) {
  const text = sanitizeTerminalOutput(
    displayText(result.content, result.details).trim(),
  );
  if (!text) return new Text("", 0, 0);
  if (options.expanded) return createMarkdownComponent(text);
  const lines = text.split("\n");
  const preview = lines.slice(0, previewLines).join("\n");
  const hidden = lines.length - previewLines;
  const hint =
    hidden > 0 ? `\n${theme.fg("dim", `... (${hidden} more lines)`)}` : "";
  return createMarkdownComponent(preview + hint);
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

export const SUBAGENT_INDEX_ROOTS = [
  HISTORIC_SUBAGENT_INDEX,
  LEGACY_SUBAGENT_INDEX,
  SUBAGENT_INDEX,
];

export function readIndex(
  indexDirs: readonly string[] = SUBAGENT_INDEX_ROOTS,
): Record<string, SubagentRecord> {
  const records: Record<string, SubagentRecord> = Object.create(null);
  for (const indexDir of indexDirs) {
    if (!existsSync(indexDir)) continue;
    try {
      for (const entry of readdirSync(indexDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        try {
          const record = JSON.parse(
            readFileSync(join(indexDir, entry.name), "utf8"),
          ) as unknown;
          if (!isSubagentRecord(record)) throw new Error("invalid record");
          // Roots are ordered oldest to newest, so newer records win.
          records[record.sessionId] = record;
        } catch (error) {
          console.warn(
            `Ignoring invalid subagent record ${entry.name}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.warn(
        `Could not read subagent index directory ${indexDir}:`,
        error,
      );
    }
  }
  return records;
}

export function atomicWriteFileSync(
  target: string,
  content: string | Buffer,
  mode = 0o600,
) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode, flush: true });
    renameSync(temporary, target);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {}
    throw error;
  }
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
  atomicWriteFileSync(target, `${JSON.stringify(record, null, 2)}\n`, 0o600);
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
  const capContent = (content: unknown) => {
    if (typeof content === "string")
      return truncateTail(content, {
        maxBytes: MODEL_OUTPUT_MAX_BYTES,
        maxLines: MODEL_OUTPUT_MAX_LINES,
      }).content;
    if (!Array.isArray(content)) return content;
    return content.flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if (part.type === "image")
        return [{ type: "text", text: "[parent image omitted from fork]" }];
      if (part.type === "text" && typeof part.text === "string")
        return [
          {
            ...part,
            text: truncateTail(part.text, {
              maxBytes: MODEL_OUTPUT_MAX_BYTES,
              maxLines: MODEL_OUTPUT_MAX_LINES,
            }).content,
          },
        ];
      return [part];
    });
  };
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
        content: capContent(`Parent conversation summary:\n${message.summary}`),
        timestamp: message.timestamp,
      });
      continue;
    }
    if (message.role === "assistant") {
      if (typeof message.content === "string") {
        sanitized.push({
          ...message,
          content: capContent(message.content),
        } as unknown as Record<string, unknown>);
        continue;
      }
      if (!Array.isArray(message.content)) continue;
      const content = message.content.flatMap((part: any) => {
        if (part.type !== "toolCall") {
          const capped = capContent([part]);
          return Array.isArray(capped) ? capped : [];
        }
        if (
          ["bg", "subagent"].includes(part.name) ||
          !resultIds.has(part.id) ||
          Buffer.byteLength(JSON.stringify(part)) > MODEL_OUTPUT_MAX_BYTES
        )
          return [];
        callIds.add(part.id);
        return [part];
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
        sanitized.push({
          ...message,
          content: capContent(message.content),
          usage: undefined,
        });
      continue;
    }
    sanitized.push({
      ...message,
      ...(Object.hasOwn(message, "content")
        ? { content: capContent((message as any).content) }
        : {}),
    } as unknown as Record<string, unknown>);
  }

  const groups: Array<Array<Record<string, unknown>>> = [];
  for (const message of sanitized) {
    if (message.role === "user") groups.push([]);
    if (groups.length) groups.at(-1)!.push(message);
  }
  const assistantTextOnly = (assistant: Record<string, unknown>) => {
    const content = assistant.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (part: any) =>
                  part?.type === "text" && typeof part.text === "string",
              )
              .map((part: any) => part.text)
              .join("\n")
          : "";
    return {
      ...assistant,
      content: truncateTail(text, {
        maxBytes: MODEL_OUTPUT_MAX_BYTES,
        maxLines: MODEL_OUTPUT_MAX_LINES,
      }).content,
    };
  };
  const trimGroup = (group: Array<Record<string, unknown>>) => {
    const user = group[0];
    const units: Array<Array<Record<string, unknown>>> = [];
    for (const message of group.slice(1)) {
      if (message.role !== "toolResult") units.push([]);
      if (units.length) units.at(-1)!.push(message);
    }
    const kept: Array<Record<string, unknown>> = user ? [user] : [];
    for (const unit of units.reverse()) {
      if (
        Buffer.byteLength(JSON.stringify([user, ...unit, ...kept.slice(1)])) <=
        FORK_CONTEXT_MAX_BYTES
      ) {
        kept.splice(1, 0, ...unit);
        continue;
      }
      // Oversized unit: keep the newest assistant reply as text only (tool
      // calls and their results are dropped together so provider context
      // stays well-formed) instead of losing the answer silently.
      const assistant = unit.find((message) => message.role === "assistant");
      if (
        assistant &&
        !kept.includes(assistant) &&
        Buffer.byteLength(
          JSON.stringify([
            user,
            assistantTextOnly(assistant),
            ...kept.slice(1),
          ]),
        ) <= FORK_CONTEXT_MAX_BYTES
      )
        kept.splice(1, 0, assistantTextOnly(assistant));
    }
    return kept;
  };
  const bounded: Array<Record<string, unknown>> = [];
  for (const original of groups.reverse()) {
    const group = trimGroup(original);
    const candidate = [...group, ...bounded];
    if (Buffer.byteLength(JSON.stringify(candidate)) > FORK_CONTEXT_MAX_BYTES) {
      if (!bounded.length) bounded.push(...group);
      break;
    }
    bounded.unshift(...group);
  }
  return bounded as any;
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

// PID-reuse protection is Linux-only (no /proc start time elsewhere). Locks
// written on other platforms omit `start` and fail closed on any live PID,
// which is safe but conservative.
function processStartIdentity(pid: number) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

export function acquireSessionLock(
  sessionId: string,
  lockDir: string = SUBAGENT_LOCKS,
) {
  if (!/^[a-zA-Z0-9-]+$/.test(sessionId))
    throw new Error(`Invalid subagent session ID: ${sessionId}`);
  ensurePrivateDir(lockDir);
  const lock = join(lockDir, sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tmp = `${lock}.tmp-${randomUUID()}`;
      try {
        mkdirSync(tmp, { mode: 0o700 });
        writeFileSync(
          join(tmp, "owner"),
          JSON.stringify({
            pid: process.pid,
            start: processStartIdentity(process.pid),
          }),
          { mode: 0o600 },
        );
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
        let ownerStart: string | undefined;
        try {
          if (existsSync(ownerFile)) {
            const rawOwner = readFileSync(ownerFile, "utf8");
            try {
              const parsed = JSON.parse(rawOwner) as {
                pid?: unknown;
                start?: unknown;
              };
              owner = Number(parsed.pid);
              ownerStart =
                typeof parsed.start === "string" ? parsed.start : undefined;
            } catch {
              owner = Number(rawOwner);
            }
          }
        } catch {}
        const ownerAlive = !Number.isNaN(owner) && processIsAlive(owner);
        const currentStart = ownerAlive
          ? processStartIdentity(owner)
          : undefined;
        const sameProcess =
          ownerStart === undefined ||
          currentStart === undefined ||
          ownerStart === currentStart;
        if (ownerAlive && sameProcess)
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

export function isPathInside(root: string, target: string) {
  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = realpathSync(root);
    realTarget = realpathSync(target);
  } catch {
    return false;
  }
  const pathFromRoot = relative(realRoot, realTarget);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) &&
      pathFromRoot !== ".." &&
      !isAbsolute(pathFromRoot))
  );
}

export function isPathInsideAny(roots: string[], target: string) {
  return roots.some((root) => isPathInside(root, target));
}

export const SUBAGENT_SESSION_ROOTS = [
  SUBAGENT_SESSION_DIR,
  LEGACY_SUBAGENT_SESSION_DIR,
  HISTORIC_SUBAGENT_SESSION_DIR,
];

export const SUBAGENT_WORKTREE_ROOTS = [
  SUBAGENT_WORKTREES,
  LEGACY_SUBAGENT_WORKTREES,
  HISTORIC_SUBAGENT_WORKTREES,
];

export function resolveSubagentCwd(parent: string, requested?: string) {
  // Models sometimes emit a leading @ in tool path arguments; strip it before
  // resolving (built-in tools follow the same convention).
  const target = resolve(parent, requested?.trim().replace(/^@/, "") || ".");
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    throw new Error(`cwd does not exist: ${target}`);
  }
  if (!isPathInside(parent, realTarget))
    throw new Error(`cwd must remain inside the parent project: ${realTarget}`);
  if (!statSync(realTarget).isDirectory())
    throw new Error(`cwd is not a directory: ${realTarget}`);
  return realTarget;
}
