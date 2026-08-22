import type {
  AgentSession,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const SUBAGENT_DIR = join(getAgentDir(), "pi-subagents");
export const LOG_DIR = join(SUBAGENT_DIR, "logs");
const MAX_RETAINED_LOGS = 50;
const MAX_RETAINED_LOG_BYTES = 100 * 1024 * 1024;
export const SUBAGENT_SESSION_DIR = join(SUBAGENT_DIR, "sessions");
export const SUBAGENT_INDEX = join(SUBAGENT_DIR, "index");
export const SUBAGENT_LOCKS = join(SUBAGENT_DIR, "locks");
export const SUBAGENT_WORKTREES = join(SUBAGENT_DIR, "worktrees");

export type TerminalState =
  "finished" | "failed" | "stopped" | "timed-out" | "interrupted";

export interface SubagentToolArgs {
  action?: "spawn" | "status" | "stop" | "steer";
  prompt?: string;
  description?: string;
  sessionId?: string;
  message?: string;
  completion?: "queue" | "continue";
  model?: string;
  thinking?: string;
  tools?: string;
  cwd?: string;
  worktree?: boolean;
  background?: boolean;
  context?: "project" | "fork";
  timeoutSec?: number;
  stop?: boolean;
  peek?: boolean;
}

export interface SubagentRecord {
  sessionId: string;
  cwd: string;
  sessionFile: string;
  model: string;
  thinking?: string;
  label: string;
  createdAt: string;
  updatedAt: string;
  state: "running" | TerminalState;
  turns: number;
  toolCount: number;
  toolFailures: number;
  usage: SessionStats["tokens"] & { cost: number };
  inheritedTools: string[];
  durationSec?: number;
  branch?: string;
  context: "project" | "fork";
  ownerPid?: number;
}

export type SubagentJobSession =
  | AgentSession
  | (Partial<AgentSession> & {
      model?: AgentSession["model"];
      thinkingLevel?: AgentSession["thinkingLevel"];
      getSessionStats: () => SessionStats;
    });

export interface SubagentJob {
  pid: number;
  command: string;
  startedAt: number;
  sessionId: string;
  controller: AbortController;
  completionId?: string;
  forceCleanup: () => void;
  originLeafId: string | null;
  expectedGeneration: number;
  originSessionFile: string;
  session: SubagentJobSession;
  activity?: string;
  baseline: SessionStats;
  record: SubagentRecord;
  toolFailures: number;
  completion?: "queue" | "continue";
  stoppedManually?: boolean;
  stopping?: boolean;
}

export function retainLog(content: string | Uint8Array, dir = LOG_DIR) {
  // Retained output logs live outside the temporary capture dir so they
  // survive process exit and pi updates. Oldest logs are pruned.
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${Date.now()}-${randomUUID()}.log`);
    writeFileSync(path, content, { mode: 0o600 });
    const logs = readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .sort();
    let retainedCount = 0;
    let retainedBytes = 0;
    const remove: string[] = [];
    for (const name of logs.reverse()) {
      const path = join(dir, name);
      let size = 0;
      try {
        size = statSync(path).size;
      } catch {
        remove.push(name);
        continue;
      }
      if (
        retainedCount >= MAX_RETAINED_LOGS ||
        retainedBytes + size > MAX_RETAINED_LOG_BYTES
      ) {
        remove.push(name);
        continue;
      }
      retainedCount++;
      retainedBytes += size;
    }
    for (const name of remove) rmSync(join(dir, name), { force: true });
    return path;
  } catch (error) {
    console.warn("Could not retain subagent output log:", error);
    return undefined;
  }
}
