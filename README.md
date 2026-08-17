# pi-subagents

Zero-config background subagents for [Pi](https://pi.dev).

Most multi-agent frameworks are overengineered: task graphs, complex DAGs, message brokers, and hundreds of lines of YAML. `pi-subagents` does one thing: it lets your agent delegate work to a child Pi session in-process, inherit the parent's environment, and report back when finished.

## Why this exists

When working on complex projects, you often need to run independent tasks in parallel:

- Research an unfamiliar library or API without polluting your main context.
- Run a deep code review or test suite in the background while continuing active work.
- Have two agents explore competing implementations of the same feature simultaneously.
- Split a large refactor across independent modules without merge conflicts.

`pi-subagents` gives the LLM a single tool: `subagent`.

## How it works

1. **Zero configuration**: The child session automatically inherits your active model, thinking budget, active tools, and working directory.
2. **In-process & fast**: No Docker containers or background daemons. Children run as lightweight Pi agent sessions inside the same process.
3. **Automatic wake-up**: When the child finishes, it delivers its result and automatically wakes up the parent turn. No status polling or sleep loops needed.
4. **Survives session reloads**: If you run `/reload`, `/new`, or `/resume`, running subagents keep executing in the background and hand their results over to the new session when finished.

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

### 2. Parallel Coding with Git Worktrees (`worktree: true`)

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

### 3. Silent Background Tasks (`background: true`)

If you want the subagent to run silently in the background without immediately interrupting your conversation when it finishes:

```json
{
  "prompt": "Run full test suite and benchmark suite against all providers",
  "background": true
}
```

The result is queued silently until your next prompt turn.

---

## Tool Reference

| Parameter    | Type      | Default    | Description                                                                        |
| :----------- | :-------- | :--------- | :--------------------------------------------------------------------------------- |
| `prompt`     | `string`  | _required_ | Self-contained task instructions for the child session.                            |
| `worktree`   | `boolean` | `false`    | Creates an isolated Git worktree for concurrent writers. Omit for read-only tasks. |
| `background` | `boolean` | `false`    | Queues the result silently instead of waking the parent turn immediately.          |

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
| **Active worktrees**        | `~/.pi/agent/pi-subagents/worktrees/` |
| **Retained logs**           | `~/.pi/agent/pi-subagents/logs/`      |

- **Output safety**: Parent-visible child output is capped at 16 KB / 400 lines to prevent token blowups. Full logs remain saved on disk if truncated.
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
