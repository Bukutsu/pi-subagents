# Changelog

## Unreleased

- Restrict child working directories to the trusted parent tree and preserve legacy sessions.
- Filter unavailable inherited tools instead of failing implicit spawns; load temporary extension paths when discoverable.
- Add branch-safe result delivery, cancellation cleanup, a cancellation grace period, and `/subagent` controls.
- Preserve legacy session locks, filter pseudo-extension paths, and isolate shared model-runtime initialization from per-spawn cancellation.
- Avoid waking the parent for manually stopped children and retain queued completion delivery after transient send failures.
- Remove the global sleep/polling blocker so unrelated Bash commands are unaffected.
- Split shell background jobs into the separate `pi-bg` extension.
- Renamed this package and its private storage to `pi-subagents`.
- Kept durable child sessions, model selection, steering, resume, and worktrees.
