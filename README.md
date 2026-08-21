# pi-subagents

Zero-config background subagents for [Pi](https://pi.dev).

Most multi-agent frameworks are overengineered: task graphs, complex DAGs, message brokers, and hundreds of lines of YAML. `pi-subagents` does one thing: it lets your agent delegate work to a child Pi session in-process, inherit the parent's environment, and report back when finished.

## Why this exists

When working on complex projects, you often need to run independent tasks in parallel:

- Research an unfamiliar library or API without polluting your main context.
- Run a deep code review or test suite in the background while continuing active work.
- Have two agents explore competing implementations of the same feature simultaneously.
- Split a large refactor across independent modules without merge conflicts.

`pi-subagents` gives the LLM two focused tools: `subagent` for delegation and `subagent_models` for deliberate model selection.

## How it works

1. **Zero configuration**: The child session automatically inherits your active model, thinking budget, active tools, and working directory.
2. **In-process & fast**: No Docker containers or background daemons. Children run as lightweight Pi agent sessions inside the same process.
3. **Synchronous by default**: Subagents block and return their (capped) result directly in the tool response. Dispatch as many children in parallel as you need; per-child and batched result caps keep parent context growth predictable.
4. **Bounded results**: Output budgets scale with the model's context window (up to 16 KB per child and 32 KB per batched delivery) to keep parent context growth predictable.
5. **Session replacement is coordinated**: `/reload`, `/new`, `/resume`, and tree navigation are blocked while subagents are running; `/reload` waits up to 10s for them to finish. Stop them with `/subagent kill all` when replacement must happen immediately.

## Install

```bash
pi install git:github.com/Bukutsu/pi-subagents
```

## Usage

### 1. Basic Delegation (Read-only / In-place)

For code audits, questions, investigations, or sequential work:

```json
{
  "prompt": "Find where authentication tokens are verified and check for expiration edge cases"
}
```

The child investigates using `read`, `bash`, `grep`, etc., and returns its findings directly to the parent conversation.

### 2. Choosing a Model

Children inherit the parent’s current model by default. For specialized work, query the live Pi model list first, then pass an exact model ID:

```text
subagent_models({})
```

```text
subagent({
  "prompt": "Review the authentication flow for security issues",
  "model": "provider/model-id"
})
```

Use `subagent_models` when reasoning ability, context size, cost, or input modality materially affects the task. Do not choose a model just because it appears first in the list.

### 3. Parallel Coding with Git Worktrees (`worktree: true`)

When multiple subagents need to write or edit code at the same time, running them in the same workspace causes race conditions and file collisions.

Set `worktree: true` to give the child an isolated Git worktree on a dedicated branch (`pi-subagents/<timestamp>-<id>`):

```json
{
  "prompt": "Refactor src/storage.ts to use SQLite instead of JSON files. Run tests to confirm it passes.",
  "worktree": true
}
```

- `pi-subagents` verifies that your working directory is clean before creating the branch.
- The worktree is created in private storage (`~/.pi/agent/pi-subagents/worktrees/`), so your repository tree stays clean.
- Once the child completes, inspect the diff and merge:
  ```bash
  git diff HEAD..pi-subagents/1740000000000-a1b2c3d4
  git merge --no-ff pi-subagents/1740000000000-a1b2c3d4
  git branch -D pi-subagents/1740000000000-a1b2c3d4
  ```

### 4. Asynchronous Background Tasks (`background: true`)

If you want the subagent to run in the background without blocking the current turn:

```json
{
  "prompt": "Run full test suite and benchmark suite against all providers",
  "background": true
}
```

The result is queued silently until your next prompt turn.

---

## Tool Reference

| Parameter    | Type      | Default    | Description                                                                                     |
| :----------- | :-------- | :--------- | :---------------------------------------------------------------------------------------------- |
| `prompt`     | `string`  | _required_ | Self-contained task instructions with context, file paths, and completion criteria.             |
| `model`      | `string`  | _unset_    | Exact model ID from `subagent_models`; omit to inherit the current model.                       |
| `worktree`   | `boolean` | `false`    | Run in an isolated Git worktree; required for concurrent file writes. Omit for read-only tasks. |
| `background` | `boolean` | `false`    | Run asynchronously in the background without blocking the current turn.                         |

`subagent_models` accepts an optional `offset` for pagination and returns live Pi model capabilities.

---

## Interactive Controls

Manage running subagents directly from Pi:

- `/subagent` — Open the interactive TUI management dialog to view active jobs and resource usage.
- `/subagent kill <pid>` — Stop a specific running subagent.
- `/subagent kill all` — Cancel all running subagents and clean up resources immediately.

---

## Storage & Isolation

All subagent state is kept in private directories outside your project tree:

| Item                        | Path                                  |
| :-------------------------- | :------------------------------------ |
| **Session records & index** | `~/.pi/agent/pi-subagents/index/`     |
| **Durable transcripts**     | `~/.pi/agent/pi-subagents/sessions/`  |
| **Session locks**           | `~/.pi/agent/pi-subagents/locks/`     |
| **Active worktrees**        | `~/.pi/agent/pi-subagents/worktrees/` |
| **Retained logs**           | `~/.pi/agent/pi-subagents/logs/`      |

- **Output safety**: Parent-visible child output is capped at 400 lines with a byte budget that scales with the model's context window (max 16 KB per child). Truncated output is retained on disk up to 10 MB (first 10 MB kept); the parent-visible result keeps the tail.
- **Recursive prevention**: Child sessions load all your standard tools, but the `subagent` tool itself is excluded inside children to prevent infinite recursion.

---

## Development

```bash
bun install
bun run check
bun test
```

## License

MIT
