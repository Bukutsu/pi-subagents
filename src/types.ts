import type {
  AgentSession,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let logDir: string | undefined;
let logDirUnavailable = false;
export const getLogDir = (): string | undefined => {
  if (logDir || logDirUnavailable) return logDir;
  try {
    return (logDir = mkdtempSync(join(tmpdir(), "pi-subagents-")));
  } catch (error) {
    logDirUnavailable = true;
    console.warn("Could not create subagent output log directory:", error);
    return undefined;
  }
};

process.on("exit", () => {
  if (logDir) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {}
  }
});

export const SUBAGENT_DIR = join(getAgentDir(), "pi-subagents");
export const HANDOFF_DIR = join(SUBAGENT_DIR, "handoff");
export const LOG_DIR = join(SUBAGENT_DIR, "logs");
const MAX_RETAINED_LOGS = 50;
export const SUBAGENT_SESSION_DIR = join(SUBAGENT_DIR, "sessions");
export const SUBAGENT_INDEX = join(SUBAGENT_DIR, "index");
export const SUBAGENT_LOCKS = join(SUBAGENT_DIR, "locks");
export const SUBAGENT_WORKTREES = join(SUBAGENT_DIR, "worktrees");

// Preserve access to sessions created before the package was renamed from
// pi-background-agents. New records continue to use the pi-subagents paths.
export const LEGACY_SUBAGENT_DIR = join(getAgentDir(), "pi-background-agents");
export const HISTORIC_SUBAGENT_DIR = join(getAgentDir(), "pi-bg");
export const LEGACY_SUBAGENT_SESSION_DIR = join(
  LEGACY_SUBAGENT_DIR,
  "sessions",
);
export const LEGACY_SUBAGENT_INDEX = join(LEGACY_SUBAGENT_DIR, "index");
export const LEGACY_SUBAGENT_LOCKS = join(LEGACY_SUBAGENT_DIR, "locks");
export const LEGACY_SUBAGENT_WORKTREES = join(LEGACY_SUBAGENT_DIR, "worktrees");
export const HISTORIC_SUBAGENT_SESSION_DIR = join(
  HISTORIC_SUBAGENT_DIR,
  "sessions",
);
export const HISTORIC_SUBAGENT_INDEX = join(HISTORIC_SUBAGENT_DIR, "index");
export const HISTORIC_SUBAGENT_LOCKS = join(HISTORIC_SUBAGENT_DIR, "locks");
export const HISTORIC_SUBAGENT_WORKTREES = join(
  HISTORIC_SUBAGENT_DIR,
  "worktrees",
);

export type TerminalState =
  "finished" | "failed" | "stopped" | "timed-out" | "interrupted";

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
  originSessionId: string;
  handedOff?: boolean;
  session: AgentSession;
  activity?: string;
  baseline: SessionStats;
  record: SubagentRecord;
  toolFailures: number;
  completion?: "queue" | "continue";
  stoppedManually?: boolean;
  stopping?: boolean;
}

export function retainLog(content: string | Uint8Array) {
  // Retained output logs live outside the temporary capture dir so they
  // survive process exit and pi updates. Oldest logs are pruned.
  try {
    mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
    const path = join(LOG_DIR, `${randomUUID()}.log`);
    writeFileSync(path, content, { mode: 0o600 });
    const logs = readdirSync(LOG_DIR)
      .filter((name) => name.endsWith(".log"))
      .sort();
    for (const name of logs.slice(
      0,
      Math.max(0, logs.length - MAX_RETAINED_LOGS),
    ))
      rmSync(join(LOG_DIR, name), { force: true });
    return path;
  } catch (error) {
    console.warn("Could not retain subagent output log:", error);
    return undefined;
  }
}
