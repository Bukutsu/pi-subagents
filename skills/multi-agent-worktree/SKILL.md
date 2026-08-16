---
name: multi-agent-worktree
description: >
  Coordinate multi-agent parallel editing and testing using isolated Git worktrees.
  Use when delegating coding tasks to subagents concurrently, editing multiple files/modules
  in parallel, running competitive exploration (tournament patterns), or isolating risky
  refactors without colliding with the parent workspace. Trigger on: "multi-agent editing",
  "parallel workers", "concurrent editing", "worktree subagent", "edit in parallel",
  "parallel coding", "isolated refactor", "competing solutions", "split task across agents".
---

# Multi-Agent Worktree Coordination

Guide for safe, predictable parallel coding and multi-agent editing using `pi-subagents` and Git worktrees.

## Core Rules

1. **Only For Concurrent Writers**: Use `worktree: true` **only** when the subagent will write/edit code, apply patches, or run commands that modify the filesystem. For read-only tasks (searching code, answering questions, reading logs, audits, reviews), omit `worktree` (default `false`) to avoid worktree creation overhead, branch lifecycle cleanup, and dirty-tree constraints.
2. **Use Native Harness Isolation**: Always call `subagent({ prompt, worktree: true })`. Never manually run `git worktree add` inside the project tree.
3. **Clean Main Workspace First**: `pi-subagents` checks that `git status --porcelain` is clean before creating a worktree. Commit or stash any uncommitted changes in the parent workspace before spawning worktrees.
4. **Subagent Branch Lifecycle**: Each worktree runs on a private branch `pi-subagents/<timestamp>-<id>`. When the child finishes, inspect the diff, integrate the result, and delete the temporary branch.

---

## Delegation Best Practices

### 1. Environment & Untracked Files

Worktrees inherit committed files at `HEAD`, but **not untracked files** (such as `.env`, `.env.local`, or generated build outputs).

- If subagent tasks require environment variables or configuration, explicitly supply them in the subagent prompt or instruct the subagent to create the necessary `.env` file.

### 2. Port & Resource Isolation

If the subagent runs dev servers, test runners, or watchers that bind network ports:

- Instruct the subagent in the prompt to use dynamic or ephemeral ports (e.g. `PORT=0`, `--port 0`) to prevent `EADDRINUSE` port collision with the parent or sibling subagents.

### 3. Baseline Verification

Always include baseline verification in the subagent prompt:

- _"Run existing tests / typechecks first to verify baseline status before making changes, then apply edits and confirm tests pass."_
  This prevents confusing pre-existing failures with new regressions.

---

## Coordination Patterns

### Pattern A: Independent Module Slicing (Parallel Tasks)

Use when splitting work across distinct files or subsystems that do not conflict.

1. **Clean & Prepare**: Ensure parent git tree is clean (`git status`).
2. **Spawn Parallel Subagents**:
   - Subagent 1: `subagent({ prompt: "Implement frontend component in src/ui/...", worktree: true })`
   - Subagent 2: `subagent({ prompt: "Implement backend endpoint in src/api/...", worktree: true })`
3. **Inspect & Integrate Each Completion**:
   When each subagent finishes with its branch name (e.g. `pi-subagents/1740000000000-a1b2c3d4`):
   ```bash
   # Inspect changes
   git diff HEAD..pi-subagents/1740000000000-a1b2c3d4

   # Merge cleanly
   git merge --no-ff pi-subagents/1740000000000-a1b2c3d4 -m "Integrate frontend component"

   # Delete temporary branch
   git branch -D pi-subagents/1740000000000-a1b2c3d4
   ```
4. **Final Verification**: Run the full project test suite in the parent workspace.

---

### Pattern B: Competitive Tournament (Speculative Exploration)

Use when investigating multiple potential solutions to a difficult bug or architecture choice.

1. **Spawn Competing Subagents**:
   - Candidate A: `subagent({ prompt: "Approach A: Refactor parser using AST visitor...", worktree: true })`
   - Candidate B: `subagent({ prompt: "Approach B: Refactor parser using regex state machine...", worktree: true })`
2. **Evaluate Solutions**:
   ```bash
   git diff HEAD..<branch-A>
   git diff HEAD..<branch-B>
   ```
3. **Pick Winner & Discard Loser**:
   - Merge the winning branch (`git merge <winner-branch>`).
   - Discard both temporary branches (`git branch -D <branch-A> <branch-B>`).

---

### Pattern C: Risky Refactoring & Code Reviews

Use to prototype a major change or run expensive test suites without disrupting the active conversation workspace.

1. Spawn with `worktree: true`.
2. Review the subagent's summary and git diff.
3. If successful, cherry-pick or merge into the active branch. If flawed, simply delete the temporary branch with zero cleanup in the main working tree.
