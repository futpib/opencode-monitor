# opencode-monitor

A **Monitor-equivalent tool for [OpenCode](https://opencode.ai)**.

`monitor` lets an agent watch an external condition — a log line appearing, a
message queue, an event source — and be woken per event **without spending agent
turns or tokens while it waits**. The watching happens in a cheap shell process;
the agent is parked and resumes the moment there is signal.

This is the OpenCode counterpart of Claude Code's Monitor tool.

## Why

Without something like this, an agent that needs to wait for events does one of
two things, both bad:

- **Poll in a loop** — every check is a full LLM turn. Expensive, slow, and it
  floods the context.
- **`sleep N` in bash** — blocks the tool call for a fixed time, is not driven
  by the actual condition, and freezes the agent.

`monitor` moves the waiting into the shell. It arms a long-lived watcher and
**each stdout line is pushed back into the session as a new turn**, so the agent
is woken per event without re-arming. The call returns immediately with a monitor
id; the agent spends roughly zero effort while parked.

## Install (OpenCode plugin)

```sh
opencode plugin /home/claude/code/opencode-monitor -g
```

This registers **both** halves of the plugin: the `monitor` / `monitor_list` /
`monitor_stop` tools (in `opencode.json`) and the sidebar panel (in `tui.json`).
Build the TUI panel first (see [Develop](#develop)) — OpenCode loads the compiled
`dist/tui.jsx`.

The `monitor` tool is available to every session on the next start. It is
equivalent to a shell tool, so configure permissions the same way you would for
`bash`.

## Use it

`monitor` always arms a streaming watcher. Each stdout line becomes a wake; the
tool returns immediately with a monitor id.

```
monitor({
  description: "errors in app.log",      // label shown in every wake + the sidebar
  command: "tail -n0 -f /var/log/app.log",
  ready_pattern: "ERROR|FATAL",          // only wake on matching lines (omit = every line)
})
```

Each wake arrives as a tagged message carrying the label:

```
<monitor id="m_1a2b3c4d" line="7" label="errors in app.log">
connection reset by peer
</monitor>
```

When the command exits (or times out) a final notice is pushed and the monitor
**disappears from the registry and the sidebar**:

```
<monitor id="m_1a2b3c4d" exited code="0" label="errors in app.log">command finished after 6 line(s); last: "done"</monitor>
```

### Bounded vs session-length

- **Bounded** (default): the watch is auto-stopped after `timeout_seconds`
  (default 300, capped at 3600). Use it when you only care about a window.
  ```
  monitor({ description: "deploy events", command: "tail -n0 -f deploy.log",
            ready_pattern: "READY|FAILED", timeout_seconds: 600 })
  ```
- **Session-length** (`persistent: true`): runs until the command exits or you
  stop it — no timeout. Use it for an always-on watcher.
  ```
  monitor({ description: "incoming DMs", command: "tg-dm-listen-raw.sh", persistent: true })
  ```

Observe or cancel armed monitors:

```
monitor_list()                 // -> active monitors with id, label, pid, line count
monitor_stop({ id: "m_1a2b3c4d" })
```

Monitors are auto-stopped when their parent session is deleted. The whole
process tree is reaped on stop (setsid session kill), so nothing leaks.

> For a **single** one-shot "tell me when X is ready, then continue" wait, prefer
> the `bash` tool with `run_in_background` and an `until`-loop — `monitor` is for
> ongoing event streams, not single returns.

## Sidebar panel

Armed monitors are shown live in the OpenCode sidebar (a `sidebar_content`
slot), next to MCP / LSP / Context. For each monitor it shows the description
(or id), the command, the line count / pid / age, and the last line received:

```
▼ Monitors (1)
● errors in app.log  m_1a2b3c4d
tail -n0 -f /var/log/app.log
lines=42 pid=3605900 age=1m3s
└ connection reset by peer
```

The panel is **collapsible**: click the `Monitors` header (or the `▼`/`▶` marker)
to collapse it to a single line, exactly like the built-in MCP panel. Monitors
vanish from the panel the moment they finish — only live watchers are listed.

The server engine exposes its live registry over a **per-invocation unix status
socket** (`<runtime>/opencode-monitor/status-<worktreeHash>-<token>.sock`, token
random per plugin load). The runtime dir is resolved via
[`xdg-basedir`](https://github.com/sindresorhus/xdg-basedir) — i.e. `XDG_RUNTIME_DIR`
on Linux (0700/user-private, OS-supplied) — falling back to the per-user temp dir
(`os.tmpdir()`) where no spec runtime dir exists (off-Linux); the server mkdirs it
`0700`. opencode can run more than one server process per worktree, and hot-reloads
plugins (so the engine can exist more than once per process) — each incarnation
hosts its own in-memory registry, so the socket carries a unique token rather than
the pid (a pid token collides with itself across reloads and orphans already-armed
monitors off the filesystem). The panel connects to **every** socket in its
worktree and merges them, so a monitor armed in any engine is visible. The server
**pushes** a snapshot on every change (armed, stopped, throttled on each line) —
no polling, no agent turns spent keeping the view current. Dead sockets left by
exited/crashed servers are pruned on the next start.

This is the conventional status-endpoint pattern (cf. docker/systemd). opencode
has no in-band channel for a plugin to surface server-side state to the TUI
(the TUI's reactive `api.state` only carries built-in domains — sessions, LSP,
MCP, todos; `tui.publish` is limited to four fixed UI-action events), and there
is no client endpoint to invoke a tool, so an out-of-band socket is the correct
way to reflect true backend state — independent of whether the session log is
synced, compacted, or even has a TUI attached. Monitors run on the opencode
**server** (a detached daemon), so they keep running and waking the session
even with no TUI open.

## How it works

The command runs under `setsid` in its own session, so when the wait ends — for
any reason — the whole process tree is reaped with `SIGTERM` then `SIGKILL`.
Grandchildren die too; nothing leaks.

Each stdout line is forwarded to the session via OpenCode's synchronous
`POST /session/:id/message` (the SDK `session.prompt`). That is the *reliable*
wake path — deliberately not the `prompt_async` endpoint, which is silently
dropped on idle sessions
([anomalyco/opencode#21524](https://github.com/anomalyco/opencode/issues/21524)).
Wakes are serialized one per turn, so a chatty watcher cannot flood the agent.

## CLI

The engine is usable outside OpenCode as a standalone "block until condition"
shell tool (a condition-driven `timeout(1)`):

```sh
node src/cli.ts 'while ! curl -sf localhost:3000/health; do sleep 1; done' --timeout 120
node src/cli.ts 'tail -n0 -f app.log' --ready 'READY|ERROR' --json
```

This CLI is the single-return engine (`runMonitor`), separate from the plugin's
streaming `monitor` tool. Exit codes follow `timeout(1)`: `124` on timeout,
otherwise the command's exit code.

## Develop

```sh
npm install
npm run build       # compile dist/tui.jsx (server.ts is loaded from source)
npm test            # node:test
npm run typecheck
```

## License

MIT
