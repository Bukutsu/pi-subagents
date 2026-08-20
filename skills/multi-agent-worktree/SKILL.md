---
name: multi-agent-worktree
description: Isolated Git worktrees for concurrent subagent tasks. Use when delegating parallel code edits across files, running competing implementations of one task, or isolating speculative refactors.
---

# Multi-Agent Worktree Coordination

Reference and workflows for parallel coding, speculative exploration, and isolated refactors using `pi-subagents` and Git worktrees.

## Rules

- **Delegation budget**: Use no more than two active subagents for one task. Use fewer when the work is simple or the slices overlap.
- **Worktree gating**: Use `worktree: true` when subagents write code concurrently or need mutation isolation. Omit `worktree` (default `false`) for read-only tasks (audits, research, reviews) and sequential in-place work.
- **Harness isolation**: Dispatch via `subagent({ prompt, worktree: true })`. Pi manages worktree creation and lifecycle outside the working tree.
- **Clean working tree**: `createWorktree` checks `git status --porcelain` before creation. Commit or stash parent changes first when the check fails.
- **Branch lifecycle**: Subagents execute on private branch `pi-subagents/<timestamp>-<id>`. Inspect diffs, merge desired changes, and delete the temporary branch upon completion.
- **Prompt self-containment**: Pass untracked configuration (`.env` files), ephemeral ports (`PORT=0`), and baseline verification directly in the child prompt; worktrees only inherit committed `HEAD`.

---

## Workflows

### Workflow 1: Disjoint Parallel Tasks (Independent Modules)

Use when splitting work across distinct files or subsystems that do not conflict.

1. **Dispatch in parallel**: Call `subagent` for each disjoint module in a single turn with `worktree: true`:
   - Subagent 1: `subagent({ prompt: "Implement frontend component in src/ui/...", worktree: true })`
   - Subagent 2: `subagent({ prompt: "Implement backend endpoint in src/api/...", worktree: true })`
2. **Inspect each branch**: When a subagent completes, run `git diff HEAD..<branch>` to review changes.
3. **Merge and clean**: Merge with `git merge --no-ff <branch> -m "Integrate <component>"` and delete the temporary branch with `git branch -D <branch>`. Repeat for each child branch.
4. **Completion verification**: Run the full project test suite and typechecks in the parent workspace to confirm clean integration with zero regressions.

---

### Workflow 2: Competitive Tournaments (Speculative Implementations)

Use when testing multiple distinct approaches to a complex problem or bug.

1. **Dispatch at most two competing candidates**: Call multiple `subagent` tasks in parallel with `worktree: true`, each specifying a different implementation approach:
   - Candidate A: `subagent({ prompt: "Approach A: Refactor parser using AST visitor...", worktree: true })`
   - Candidate B: `subagent({ prompt: "Approach B: Refactor parser using regex state machine...", worktree: true })`
2. **Evaluate solutions**: Compare candidate branches using `git diff HEAD..<branch-A>` and `git diff HEAD..<branch-B>`, checking test pass rates and implementation simplicity.
3. **Merge winner**: Run `git merge --no-ff <winner-branch> -m "Apply winning approach"`.
4. **Prune candidate branches**: Delete all candidate branches with `git branch -D <branch-A> <branch-B>`.
5. **Completion verification**: Run the full test suite in the parent workspace.

---

### Workflow 3: Speculative Refactoring (Zero-Risk Prototyping)

Use to test large refactors or risky changes without modifying the working tree.

1. **Dispatch subagent**: Call `subagent({ prompt: "Refactor storage layer to SQLite...", worktree: true })`.
2. **Inspect changes**: Review child output and diff with `git diff HEAD..<branch>`.
3. **Branch disposition**:
   - If accepted: `git merge --no-ff <branch>` and delete with `git branch -D <branch>`.
   - If rejected: Delete with `git branch -D <branch>` (main workspace remains untouched).
4. **Completion verification**: When merged, run project tests and typechecks to confirm zero regressions.
