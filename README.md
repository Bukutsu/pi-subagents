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

The child runs in the background. Results default to queue mode; use
`"completion": "continue"` when completion should wake the parent. Do not poll
`subagent status` or use shell sleep loops to wait. If you
navigate to another conversation branch, the result waits until you return to
the originating branch.

Use `/subagent` to list running children, `/subagent kill <pid>` to stop one, or
`/subagent kill all` to stop every running child.

### Parameters

| Name          | Purpose                                                                    |
| ------------- | -------------------------------------------------------------------------- |
| `action`      | `spawn`, `models`, `status`, `steer`, or `stop`                            |
| `prompt`      | Task for a new or resumed session                                          |
| `description` | Short label shown in status output                                         |
| `sessionId`   | Durable session to resume, inspect, steer, or stop                         |
| `message`     | Guidance queued after the current turn (`steer`)                           |
| `completion`  | `queue` is the default; `continue` wakes the parent when ready             |
| `model`       | Model from the active Pi model scope                                       |
| `thinking`    | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`               |
| `tools`       | Comma-separated allowlist that narrows inherited tools                     |
| `cwd`         | Existing directory inside the parent project; symlinks must stay inside it |
| `worktree`    | Create a persistent Git worktree for a new session                         |
| `context`     | `project` for a fresh context, `fork` for sanitized parent history         |
| `timeoutSec`  | Maximum run time in seconds; defaults to 600                               |

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

The extension reads Pi's live, session-specific `scopedModels` on every tool
call and intersects it with currently available models. Use
`{ "action": "models" }` before choosing an explicit model when the user may
have changed `/scoped-models`; results are paginated with `modelOffset`. An empty
scope means any available model may be selected explicitly. Omit `model` to
inherit the parent model. If a resumed session's saved model leaves the live
scope, it resumes on the parent model when available, otherwise the first
available scoped model, and reports the fallback.

## Storage

| Data                       | Location                             |
| -------------------------- | ------------------------------------ |
| Session records and index  | `<agent-dir>/pi-subagents`           |
| Worktrees                  | `<agent-dir>/pi-subagents/worktrees` |
| Temporary long-output logs | Operating-system temp directory      |

Parent-visible child output is capped at 16 KB or 400 lines; longer output stays
in the durable session and a temporary log capped at 10 MB. Fork context keeps
recent complete conversation/tool groups within a 64 KB aggregate budget and
applies the 16 KB cap to individual copied text.

The storage directories are private. A running child survives session
replacement (`/reload`, `/new`, `/resume`, `/fork`, `/clone`, `/import`): it
keeps running in the previous runtime and its result is delivered when the
originating session is active again (matched by session id or file path), where
it appears as "finishing (session reload)" and cannot be steered until it
settles. Retained output logs are written under `<agent-dir>/pi-subagents/logs`
(newest 50 kept) so they survive process exit and updates.

### Lifecycle behavior

| Event                                                                          | Effect on children                                                                 |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `/reload`, `/new`, `/resume`, `/fork`, `/clone`, `/import`                     | Child keeps running; result handed to the origin session's next runtime            |
| `/tree`, `/compact`, model/thinking change                                     | Unaffected                                                                         |
| Ctrl+Z suspend                                                                 | Children pause with pi (process-group `SIGTSTP`) and resume on `fg`                |
| Quit (Ctrl+D, SIGHUP, `ctx.shutdown()`, pi update restart)                     | Children stop; records are marked interrupted and remain resumable                 |
| Print mode (`-p`)                                                              | Process exits after each prompt; children stop                                     |
| RPC mode                                                                       | Delivery works; `completion:"continue"` runs a turn in-process                     |
| Extension load failure on `/reload`                                            | Old children keep running but nothing drains them; entries expire after 10 minutes | Sessions created by |
| older `pi-background-agents` and historical `pi-bg` releases remain readable   |
| and resumable. Unavailable tools are omitted from implicit inheritance and are |
| reported in the spawn result.                                                  |

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
