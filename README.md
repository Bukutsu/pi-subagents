# pi-subagents

SDK-native, zero-configuration background subagents for [Pi](https://pi.dev).

The extension provides one small `subagent` tool for delegating exploration,
research, code review, and implementation work to child Pi sessions. Children
inherit the parent model and tools, run with no configuration, and deliver their
results automatically.

## Trust model

This is a trusted-local developer tool, not a sandbox. Child sessions inherit
the parent's active tools except the recursive `subagent` tool, and may edit
files in their working directory. Use an OS or container sandbox separately
when that boundary matters.

## Install

```bash
pi install git:github.com/Bukutsu/pi-subagents
```

## Delegate work

```json
{
  "prompt": "Review the authentication flow for correctness"
}
```

The child inherits the parent model, thinking level, tools, and working
directory. Its result automatically wakes the parent. Continue useful,
independent work after spawning; never poll status or use shell sleep loops.

Use `background: true` only when the result should wait silently for a later
turn. Use `worktree: true` when concurrent writers need isolated Git branches.

```json
{
  "prompt": "Review the authentication flow for correctness",
  "worktree": true,
  "background": true
}
```

When several subagents are independent, spawn them in one turn. Worktrees are
left on disk for review and are not merged or deleted automatically.

Use `/subagent` to manage running children in the TUI, `/subagent kill <pid>` to
stop one, or `/subagent kill all` to stop every running child.

### Parameters

| Name         | Purpose                                                  |
| ------------ | -------------------------------------------------------- |
| `prompt`     | Self-contained task for the child                        |
| `worktree`   | Create an isolated Git worktree for concurrent writers   |
| `background` | Queue the result without automatically waking the parent |

The child starts with a fresh project context. Parent history is not copied by
default; include relevant context in the prompt. Durable session files are kept
automatically for lifecycle recovery and inspection.

## Result delivery

Normal delegation wakes the parent when the child finishes. `background: true`
keeps the result queued until a later parent turn. Results are delivered as
bounded machine-readable metadata plus the child's natural-language final
answer; the child is not forced to produce JSON.

If you navigate to another conversation branch, the result waits until you
return to the originating branch.

## Storage

| Data                      | Location                             |
| ------------------------- | ------------------------------------ |
| Session records and index | `<agent-dir>/pi-subagents`           |
| Worktrees                 | `<agent-dir>/pi-subagents/worktrees` |
| Retained output logs      | `<agent-dir>/pi-subagents/logs`      |

Storage is private. Parent-visible child output is capped at 16 KB or 400 lines;
longer output remains in the durable child session and a retained log capped at
10 MB.

## Lifecycle behavior

| Event                                       | Effect on children                               |
| ------------------------------------------- | ------------------------------------------------ |
| `/reload`, `/new`, `/resume`, `/fork`, etc. | Children keep running and results are handed off |
| `/tree`, `/compact`, model/thinking change  | Children are unaffected                          |
| Ctrl+Z                                      | Children pause with Pi and resume on `fg`        |
| Quit or shutdown                            | Children stop and are marked interrupted         |
| Print mode (`-p`)                           | Children stop when the process exits             |
| RPC mode                                    | Completion delivery runs in-process              |

Historical sessions from older `pi-background-agents` and `pi-bg` releases
remain readable and resumable internally.

## Development

```bash
bun install
bun run check
bun test
```

The extension is intentionally subagent-only. Shell commands and terminal jobs
belong in a separate background-task extension.

## License

MIT
