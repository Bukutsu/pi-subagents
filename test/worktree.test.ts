import assert from "node:assert/strict";
import test from "node:test";
import { createWorktree } from "../src/worktree.js";

test("rejects worktree creation when parent repository has uncommitted changes", async () => {
  const pi: any = {
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: process.cwd(), stderr: "" };
      }
      if (cmd === "git" && args[0] === "status") {
        return { code: 0, stdout: " M modified-file.ts\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx: any = { cwd: process.cwd() };

  await assert.rejects(
    () => createWorktree(pi, ctx),
    /parent repository has uncommitted changes/,
  );
});

test("creates worktree when repository is clean", async () => {
  const calls: string[][] = [];
  const pi: any = {
    exec: async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: process.cwd(), stderr: "" };
      }
      if (cmd === "git" && args[0] === "status") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.includes("worktree")) {
        return { code: 0, stdout: "Preparing worktree", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx: any = { cwd: process.cwd() };

  const res = await createWorktree(pi, ctx);
  assert.ok(res.branch.startsWith("pi-subagents/"));
  assert.ok(res.path.length > 0);
  assert.ok(
    calls.some((c) => c.includes("status") && c.includes("--porcelain")),
  );
});

test("serializes concurrent worktree creations on the same repository", async () => {
  let inFlight = 0;
  let maxConcurrent = 0;
  const pi: any = {
    exec: async (cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "rev-parse") {
        return { code: 0, stdout: process.cwd(), stderr: "" };
      }
      if (cmd === "git" && args[0] === "status") {
        inFlight++;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd === "git" && args.includes("worktree")) {
        return { code: 0, stdout: "Preparing worktree", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  const ctx: any = { cwd: process.cwd() };

  const [res1, res2] = await Promise.all([
    createWorktree(pi, ctx),
    createWorktree(pi, ctx),
  ]);

  assert.equal(maxConcurrent, 1);
  assert.notEqual(res1.branch, res2.branch);
});
