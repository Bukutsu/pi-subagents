import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { SUBAGENT_WORKTREES } from "./types.js";
import { ensurePrivateDir } from "./utils.js";

export async function getGitBranch(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await pi.exec(
      "git",
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { cwd, signal },
    );
    return result.code === 0 ? result.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function getGitCommonDir(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      signal,
    });
    return result.code === 0
      ? realpathSync(resolve(cwd, result.stdout.trim()))
      : undefined;
  } catch {
    return undefined;
  }
}

const repoLocks = new Map<string, Promise<unknown>>();

export function withRepoLock<T>(
  root: string,
  fn: () => Promise<T>,
): Promise<T> {
  const current = repoLocks.get(root) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = current.then(
    () => next,
    () => next,
  );
  repoLocks.set(root, chained);
  return current.then(fn, fn).finally(() => {
    release();
    if (repoLocks.get(root) === chained) {
      repoLocks.delete(root);
    }
  });
}

async function internalRemoveWorktree(
  pi: ExtensionAPI,
  root: string,
  path: string,
  branch?: string,
): Promise<void> {
  let removed = false;
  try {
    const res = await pi.exec(
      "git",
      ["-c", "core.hooksPath=/dev/null", "worktree", "remove", "--force", path],
      {
        cwd: root,
      },
    );
    removed = res.code === 0;
  } catch {}
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
  // If git removal failed, drop the stale registration so the branch is not
  // left "checked out"; delete the branch either way (best effort).
  if (!removed) {
    try {
      await pi.exec(
        "git",
        ["-c", "core.hooksPath=/dev/null", "worktree", "prune"],
        { cwd: root },
      );
    } catch {}
  }
  if (branch) {
    try {
      await pi.exec(
        "git",
        ["-c", "core.hooksPath=/dev/null", "branch", "-D", branch],
        { cwd: root },
      );
    } catch {}
  }
}

export async function removeWorktree(
  pi: ExtensionAPI,
  cwd: string,
  path: string,
  branch?: string,
): Promise<void> {
  if (!path?.trim()) return;
  // Resolve the git repo root so we run git commands from the right place,
  // even if callers pass ctx.cwd instead of the repo root.
  let root = cwd;
  try {
    const res = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd,
    });
    if (res.code === 0) root = res.stdout.trim();
  } catch {}
  return withRepoLock(root, () =>
    internalRemoveWorktree(pi, root, path, branch),
  );
}

export async function createWorktree(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<{ branch: string; path: string }> {
  const rootResult = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
    cwd: ctx.cwd,
    signal,
  });
  if (rootResult.code !== 0)
    throw new Error(
      `worktree:true requires a Git worktree: ${rootResult.stderr.trim() || ctx.cwd}`,
    );
  const root = realpathSync(rootResult.stdout.trim());
  return withRepoLock(root, async () => {
    const statusResult = await pi.exec("git", ["status", "--porcelain"], {
      cwd: root,
      signal,
    });
    if (statusResult.code === 0 && statusResult.stdout.trim().length > 0) {
      throw new Error(
        "Cannot create worktree: parent repository has uncommitted changes. Commit or stash them before using worktree:true.",
      );
    }
    const id = randomUUID().slice(0, 8);
    const branch = `pi-subagents/${Date.now()}-${id}`;
    ensurePrivateDir(SUBAGENT_WORKTREES);
    const path = join(SUBAGENT_WORKTREES, `${basename(root)}-${id}`);
    try {
      const result = await pi.exec(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "worktree",
          "add",
          "-b",
          branch,
          path,
        ],
        { cwd: root, signal },
      );
      if (result.code !== 0)
        throw new Error(
          `Could not create worktree: ${result.stderr.trim() || result.stdout.trim()}`,
        );
    } catch (error) {
      // The add may have failed before creating this branch. Do not pass the
      // generated name to cleanup: it could already belong to someone else.
      await internalRemoveWorktree(pi, root, path);
      throw error;
    }
    let resolvedPath = path;
    try {
      resolvedPath = realpathSync(path);
    } catch {}
    return { branch, path: resolvedPath };
  });
}
