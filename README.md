# opencode-monitor

A **Monitor-equivalent tool for [OpenCode](https://opencode.ai)**.

`monitor` lets an agent block on an external condition — a port opening, a file
appearing, a CI run finishing, a log line showing up — **without spending agent
turns or tokens while it waits**. The waiting happens in a cheap shell process;
the agent is parked and resumes the moment there is signal.

This is the OpenCode counterpart of Claude Code's Monitor tool, built around the
use case rather than the mechanism.

## Why

Without something like this, an agent that needs to wait does one of two things,
both bad:

- **Poll in a loop** — every check is a full LLM turn. Expensive, slow, and it
  floods the context.
- **`sleep N` in bash** — blocks the tool call for a fixed time, is not driven by
  the actual condition, and freezes the agent.

`monitor` moves the waiting into the shell and returns control only when the
condition is true (the command exits), when a stdout line matches a pattern
(`ready_pattern`), or when a timeout elapses. The agent spends roughly zero
effort while parked.

## Install (OpenCode plugin)

Point OpenCode at this project from `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["file:///home/claude/code/opencode-monitor/src/index.ts"]
}
```

The `monitor` tool is available to every session on the next start. It is
equivalent to a shell tool, so configure permissions the same way you would for
`bash`.

## Use it

Ask the agent to wait, or call the tool directly:

```
monitor({
  command: "while ! curl -sf localhost:3000/health; do sleep 1; done",
  timeout_seconds: 120
})
```

Wait for a file:

```
monitor({ command: "while [ ! -f build/done ]; do sleep 1; done" })
```

Tail a log until a line matches:

```
monitor({ command: "tail -n0 -f app.log", ready_pattern: "READY|ERROR", timeout_seconds: 60 })
```

The tool returns a compact summary plus the captured output:

```
outcome=ready  ready_line="READY"  elapsed=3.4s
---- output ----
booting
READY
```

`outcome` is one of `ready` (a line matched), `exited` (the command exited), or
`timeout` (the deadline passed). Captured stderr lines are prefixed `[stderr]`.
Output is held in a ring buffer (`maxLines`, default 500) so a runaway process
cannot blow up the context.

## How it works

The command runs under `setsid` in its own session, so when the wait ends — for
any reason — the whole process tree is reaped with `SIGTERM` then `SIGKILL`.
Grandchildren die too; nothing leaks.

The design is deliberately **single-return**: the agent parks on one tool call
and resumes once. That is what makes it token-cheap, and it sidesteps the
reactive-wake gaps in OpenCode today (the async prompt path is flaky on idle
sessions). If you ever need per-line streaming wake-ups instead, the same engine
can drive an external loop that calls OpenCode's synchronous
`POST /session/:id/message` — that variant is intentionally out of scope here.

## CLI

The engine is usable outside OpenCode:

```sh
node src/cli.ts 'while ! curl -sf localhost:3000/health; do sleep 1; done' --timeout 120
node src/cli.ts 'tail -n0 -f app.log' --ready 'READY|ERROR' --json
```

Exit codes follow `timeout(1)`: `124` on timeout, otherwise the command's exit
code.

## Develop

```sh
npm install
npm test         # node:test
npm run typecheck
```

## License

MIT
