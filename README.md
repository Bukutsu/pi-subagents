# pi-subagents

SDK-native background subagents for [Pi](https://pi.dev).

The extension provides one `subagent` tool for delegating exploration, research,
code review, and implementation work to child Pi sessions without blocking the
parent session.

## Trust model

This is a trusted-local developer tool, not a sandbox. Child sessions inherit
the parent's active tools unless narrowed with `tools`, and may edit files in
their working directory. Use an OS or container sandbox separately when that
boundary matters.

## Install

```bash
pi install git:github.com/Bukutsu/pi-subagents
```

## Spawn a subagent

```json
{
  "prompt": "Review the authentication flow for correctness",
  "description": "Auth review",
  "thinking": "high"
}
```

The child runs in the background. Its result is delivered automatically when it
finishes; do not poll `subagent status` or use shell sleep loops to wait.

### Parameters

| Name          | Purpose                                                            |
| ------------- | ------------------------------------------------------------------ |
| `action`      | `spawn`, `status`, `steer`, or `stop`                              |
| `prompt`      | Task for a new or resumed session                                  |
| `description` | Short label shown in status output                                 |
| `sessionId`   | Durable session to resume, inspect, steer, or stop                 |
| `message`     | Guidance queued after the current turn (`steer`)                   |
| `completion`  | `continue` wakes the parent; `queue` waits for the next prompt     |
| `model`       | Model from the active Pi model scope                               |
| `thinking`    | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`       |
| `tools`       | Comma-separated allowlist that narrows inherited tools             |
| `cwd`         | Existing directory inside the parent project                       |
| `worktree`    | Create a persistent Git worktree for a new session                 |
| `context`     | `project` for a fresh context, `fork` for sanitized parent history |
| `timeoutSec`  | Maximum run time in seconds; defaults to 600                       |

When several subagents are independent, spawn them in one turn. Use a separate
Git worktree for concurrent edits. Worktrees are left on disk for review and
are not merged or deleted automatically.

## Resume

Sessions are durable. Resume one with its ID or an unambiguous prefix:

```json
{
  "sessionId": "a1b2c3d4",
  "prompt": "Apply the fixes from your review"
}
```

A running session can be steered without canceling its current turn:

```json
{
  "action": "steer",
  "sessionId": "a1b2c3d4",
  "message": "Check the retry path too"
}
```

## Model selection

The extension respects Pi's active `scopedModels` configuration. Explicit model
requests must match that scope. Without an active scope, a requested model is
ignored and the child uses the parent's model.

## Storage

| Data                       | Location                             |
| -------------------------- | ------------------------------------ |
| Session records and index  | `<agent-dir>/pi-subagents`           |
| Worktrees                  | `<agent-dir>/pi-subagents/worktrees` |
| Temporary long-output logs | Operating-system temp directory      |

The storage directories are private. A running child is stopped when the Pi
session shuts down; completed sessions remain resumable.

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
