# Contributing

## Setup

```bash
git clone https://github.com/Bukutsu/pi-subagents.git
cd pi-subagents
bun install
```

## Verify

```bash
bun run check
bun test
```

Keep changes focused on child Pi sessions. Shell process management belongs in
`pi-bg`.
