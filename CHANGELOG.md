# Changelog

## Unreleased

- Render subagent output with pi's native markdown theme (syntax-highlighted code blocks and theme-customizable markdown colors).
- Keep children running across session replacement (`/reload`, `/new`,
  `/resume`, `/fork`, `/clone`); results are handed to the next runtime of the
  origin session (matched by session id or file path), restored children show
  as "finishing (session reload)", and steering them is deferred until they
  settle. Retained output logs now live in
  `<agent-dir>/pi-subagents/logs` (newest 50 kept).

- Query the live, available session model scope with paginated `action:models`; do not cache unsaved scope edits.
- Resume atomically on a current scoped fallback and persist effective model/thinking changes.
- Use compact model-visible JSON, final 16 KB/400-line output caps, and human-only display details.
- Default completions to queue mode, batch by origin within the byte budget, cap retained logs at 10 MB, and deduplicate delivery.
- Bound fork context by complete message/tool groups within a 64 KB aggregate budget and preserve the newest assistant reply.
- Sync parent runtime credentials and availability on resumes, and avoid requeueing completions the session already persisted.
- Remove repeated scoped-model injection and shorten persistent tool guidance.
- Preserve and resume historical sessions from the original pi-bg storage root.
- Retain completions until the originating session-tree branch is active again.
- Reject resumed sessions whose saved model is outside the active model scope.
- Exclude subagent recursion from implicit child-tool inheritance.
- Show manually stopped children as stopping until cleanup completes.
- Continue when temporary output-log setup is unavailable.
- Harden lock ownership against Linux PID reuse.
- Pin development checks to Pi 0.84.1 and override the vulnerable brace-expansion release.
- Add lifecycle and historical-record regression coverage.
- Restrict child working directories to the trusted parent tree and preserve legacy sessions.
- Filter unavailable inherited tools instead of failing implicit spawns; load temporary extension paths when discoverable.
- Add branch-safe result delivery, cancellation cleanup, a cancellation grace period, and `/subagent` controls.
- Preserve legacy session locks, filter pseudo-extension paths, and isolate shared model-runtime initialization from per-spawn cancellation.
- Avoid waking the parent for manually stopped children and retain queued completion delivery after transient send failures.
- Remove the global sleep/polling blocker so unrelated Bash commands are unaffected.
- Split shell background jobs into the separate `pi-bg` extension.
- Renamed this package and its private storage to `pi-subagents`.
- Kept durable child sessions, model selection, steering, resume, and worktrees.
