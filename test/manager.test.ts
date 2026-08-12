import assert from "node:assert/strict";
import test from "node:test";
import { SubagentManager } from "../src/manager.js";

test("killAllJobs aborts active subagents and pending setup", () => {
  const manager = new SubagentManager({} as any);
  const first = new AbortController();
  const second = new AbortController();
  const setup = new AbortController();
  manager.jobs.set(1, { controller: first } as any);
  manager.jobs.set(2, { controller: second } as any);
  const release = manager.trackSetup(setup);

  assert.equal(manager.killAllJobs(), 3);
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(setup.signal.aborted, true);
  assert.equal(manager.killAllJobs(), 0);

  release();
});
