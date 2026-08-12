import type {
  AgentSession,
  SessionStats,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let logDir: string | undefined;
export const getLogDir = () =>
  (logDir ??= mkdtempSync(join(tmpdir(), "pi-subagents-")));

process.on("exit", () => {
  if (logDir) {
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {}
  }
});

export const SUBAGENT_DIR = join(getAgentDir(), "pi-subagents");
export const SUBAGENT_SESSION_DIR = join(SUBAGENT_DIR, "sessions");
export const SUBAGENT_INDEX = join(SUBAGENT_DIR, "index");
export const SUBAGENT_LOCKS = join(SUBAGENT_DIR, "locks");
export const SUBAGENT_WORKTREES = join(SUBAGENT_DIR, "worktrees");

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
  forceDispose: () => void;
  session: AgentSession;
  activity?: string;
  baseline: SessionStats;
  record: SubagentRecord;
  toolFailures: number;
  completion?: "queue" | "continue";
  stoppedManually?: boolean;
}
