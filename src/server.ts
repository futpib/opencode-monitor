import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { createServer, type Socket } from "node:net"
import { unlinkSync, mkdirSync } from "node:fs"
import { createMonitorManager } from "./manager.ts"
import { serverSocketPath, socketDir, pruneDeadSockets } from "./identity.ts"

const ID = "opencode-monitor"

const DESCRIPTION = `Watch an external condition without spending agent turns. Runs a shell command and arms a watcher: the agent is parked (near-zero cost) and EACH stdout line is pushed back into the session as a new turn (a <monitor> notification), so the agent is woken per event without re-arming. Returns immediately with a monitor id.

This is the streaming-wake counterpart of a long-lived watcher — tailing a log, a message queue, an event source. For a SINGLE one-shot "tell me when X is ready" wait, prefer the bash tool with run_in_background + an until-loop; this tool is for ongoing event streams.

- persistent (default false): when false the watch is bounded by timeout_seconds; when true it runs for the whole session until the command exits or monitor_stop is called.
- ready_pattern: only wake on stdout lines matching this regex (wake on every line if omitted).
- A monitor disappears from the registry (and the sidebar) once its command exits or times out; monitor_stop cancels one early.

Examples:
- watch a log: command="tail -n0 -f app.log", ready_pattern="ERROR|FATAL", description="errors in app.log"
- react to each event forever: command="<watcher that prints one event per line>", persistent=true
- bounded watch: command="tail -n0 -f deploy.log", ready_pattern="READY|FAILED", timeout_seconds=600`

const clampTimeoutMs = (v: unknown): number => {
  const requested = Math.floor(Number(v ?? 300)) || 300
  return Math.min(Math.max(requested, 1), 3600) * 1000
}

export const server: Plugin = async ({ client, directory }) => {
  const mgr = createMonitorManager(client)

  // Status socket: push the live registry to any connected TUI. The token must
  // be unique per FACTORY INVOCATION, not per process — opencode hot-reloads
  // plugins (e.g. when the source changes), so the factory can run more than
  // once in one process. A pid token collides with itself across reloads: the
  // second run unlinks+rebinds the same path, orphaning the first run's engine
  // (which holds any already-armed monitors) off the filesystem. A random token
  // gives each invocation its own socket file, all of which the TUI globs and
  // merges. opencode provides no in-band plugin server->TUI channel, so this
  // out-of-band socket is the conventional status-endpoint pattern.
  const token = crypto.randomUUID().slice(0, 8)
  const sockPath = serverSocketPath(directory, token)
  const clients = new Set<Socket>()
  const snapshot = () =>
    JSON.stringify({ updatedAt: Date.now(), monitors: mgr.list() }) + "\n"
  const send = (s: Socket) => {
    try {
      s.write(snapshot())
    } catch {
      clients.delete(s)
    }
  }
  // Remove orphaned sockets from crashed/restarted servers (incl. the legacy
  // single-key files) before we bind our own.
  await pruneDeadSockets(directory)
  try {
    mkdirSync(socketDir(), { recursive: true })
  } catch {
    /* best-effort */
  }
  try {
    unlinkSync(sockPath)
  } catch {
    /* no stale socket for this pid */
  }
  try {
    const srv = createServer((socket) => {
      clients.add(socket)
      send(socket)
      socket.on("error", () => clients.delete(socket))
      socket.on("close", () => clients.delete(socket))
    })
    srv.on("error", () => {
      /* socket unavailable — panel just won't get pushes; tools still work */
    })
    srv.listen(sockPath)
  } catch {
    /* best-effort; the monitor tools work without the panel */
  }
  // Best-effort cleanup of our own socket on shutdown. SIGKILL/crash leaves it
  // orphaned; the next server start prunes it via pruneDeadSockets.
  process.on("exit", () => {
    try {
      unlinkSync(sockPath)
    } catch {
      /* ignore */
    }
  })
  mgr.subscribe(() => {
    for (const s of clients) send(s)
  })

  return {
    tool: {
      monitor: tool({
        description: DESCRIPTION,
        args: {
          description: tool.schema
            .string()
            .describe(
              "Short label for this monitor, shown in every wake notification and the sidebar. Be specific (e.g. 'errors in app.log', not 'watching logs').",
            ),
          command: tool.schema
            .string()
            .describe(
              "Shell command — a long-lived watcher that prints one event per stdout line (e.g. tail -f, inotifywait -m).",
            ),
          persistent: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, run for the whole session (no timeout) until the command exits or monitor_stop. Default false (bounded by timeout_seconds).",
            ),
          ready_pattern: tool.schema
            .string()
            .optional()
            .describe(
              "Only wake on stdout lines matching this regex; omit to wake on every line.",
            ),
          timeout_seconds: tool.schema
            .number()
            .optional()
            .describe(
              "When persistent is false (default), auto-stop the watch after this many seconds. Default 300, capped at 3600. Ignored when persistent.",
            ),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory. Defaults to the project directory."),
        },
        async execute(args: any, context: any) {
          const cwd = args.cwd ?? context?.directory
          const persistent = Boolean(args.persistent)
          const timeoutMs = persistent ? undefined : clampTimeoutMs(args.timeout_seconds)
          const m = mgr.arm({
            command: String(args.command),
            cwd,
            description: args.description ? String(args.description) : undefined,
            parentSessionId: context?.sessionID,
            readyPattern: args.ready_pattern,
            timeoutMs,
          })
          const bounds = persistent
            ? "session-length (no timeout)"
            : `timeout ${Math.round((timeoutMs ?? 0) / 1000)}s`
          const lines = [
            `<monitor_armed id="${m.id}">`,
            m.description ? `label: ${m.description}` : null,
            `command: ${m.command}`,
            `bounds: ${bounds}`,
            `pid: ${m.pid ?? "?"}`,
            `parent_session: ${m.parentSessionId}`,
            `Each stdout line wakes this session. Use monitor_list / monitor_stop to observe or cancel.`,
            `</monitor_armed>`,
          ]
          return lines.filter((l) => l !== null).join("\n")
        },
      }),

      monitor_list: tool({
        description: "List active monitors armed via monitor (each runs until its command exits, times out, or is stopped).",
        args: {},
        async execute() {
          const items = mgr.list()
          if (items.length === 0) return "(no active monitors)"
          return [
            "active monitors:",
            ...items.map(
              (m) =>
                `- ${m.id}  ${m.description ? `${JSON.stringify(m.description)}  ` : ""}pid=${m.pid ?? "?"}  lines=${m.lineCount}  cmd=${JSON.stringify(m.command)}`,
            ),
          ].join("\n")
        },
      }),

      monitor_stop: tool({
        description: "Stop and reap a monitor by id (the m_xxxx from monitor_list / monitor_armed).",
        args: {
          id: tool.schema.string().describe("Monitor id, e.g. m_1a2b3c4d."),
        },
        async execute(args: any) {
          return mgr.stop(String(args.id)) ? `stopped ${args.id}` : `no such monitor: ${args.id}`
        },
      }),
    },

    event: async ({ event }) => {
      if (event?.type === "session.deleted") {
        const sessionId = (event as { properties?: { info?: { id?: string } } }).properties?.info?.id
        if (sessionId) mgr.cleanupBySession(sessionId)
      }
    },
  }
}

export default { id: ID, server }
