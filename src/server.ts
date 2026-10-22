import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import { v1Delivery, v2Delivery } from "./delivery.ts"
import type { MonitorDelivery } from "./manager.ts"
import { createServer, type Socket } from "node:net"
import { unlinkSync, mkdirSync } from "node:fs"
import { createMonitorManager } from "./manager.ts"
import { serverSocketPath, socketDir, pruneDeadSockets } from "./identity.ts"

const ID = "opencode-monitor"

const DESCRIPTION = `Watch an external condition without spending agent turns. Runs a shell command and arms a watcher: EACH matching stdout line is pushed into the session as a <monitor> notification. Events wake an idle agent and steer an active run at its next model-turn boundary, without interrupting streaming or waiting for earlier wakes to finish. Returns immediately with a monitor id.

This is the streaming-wake counterpart of a long-lived watcher — tailing a log, a message queue, an event source. For a SINGLE one-shot "tell me when X is ready" wait, use a background shell command with an until-loop (v1: bash run_in_background; v2: shell background=true); this tool is for ongoing event streams.

- persistent (default false): when false the watch is bounded by timeout_seconds; when true it runs for the whole session until the command exits or monitor_stop is called.
- ready_pattern: only wake on stdout lines matching this regex (wake on every line if omitted).
- steer (default true): submit events as they arrive, including during active runs. Set false to preserve serialized delivery: wait for the full agent response to each wake before submitting the next event.
- A monitor disappears from the registry (and the sidebar) once its command exits or times out; monitor_stop cancels one early.

Examples:
- watch a log: command="tail -n0 -f app.log", ready_pattern="ERROR|FATAL", description="errors in app.log"
- react to each event forever: command="<watcher that prints one event per line>", persistent=true
- bounded watch: command="tail -n0 -f deploy.log", ready_pattern="READY|FAILED", timeout_seconds=600`

const clampTimeoutMs = (v: unknown): number => {
  const requested = Math.floor(Number(v ?? 300)) || 300
  return Math.min(Math.max(requested, 1), 3600) * 1000
}

async function createServerPlugin(deliver: MonitorDelivery, directory: string) {
  const mgr = createMonitorManager(deliver)

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
    mkdirSync(socketDir(), { recursive: true, mode: 0o700 })
  } catch {
    /* best-effort */
  }
  try {
    unlinkSync(sockPath)
  } catch {
    /* no stale socket for this pid */
  }
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
  // Best-effort cleanup of our own socket on shutdown. SIGKILL/crash leaves it
  // orphaned; the next server start prunes it via pruneDeadSockets.
  const removeSocket = () => {
    try {
      unlinkSync(sockPath)
    } catch {
      /* ignore */
    }
  }
  process.on("exit", removeSocket)
  const unsubscribe = mgr.subscribe(() => {
    for (const s of clients) send(s)
  })
  let disposed = false

  return {
    mgr,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      mgr.dispose()
      for (const socket of clients) socket.destroy()
      clients.clear()
      srv.close()
      process.off("exit", removeSocket)
      removeSocket()
    },
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
          steer: tool.schema
            .boolean()
            .optional()
            .describe(
              "Default true: events steer an active run at the next model-turn boundary and wake idle sessions. Set false to wait for each wake's full agent response before submitting the next event.",
            ),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory. Defaults to the project directory."),
        },
        async execute(args: any, context: any) {
          const cwd = args.cwd ?? directory
          const persistent = Boolean(args.persistent)
          const timeoutMs = persistent ? undefined : clampTimeoutMs(args.timeout_seconds)
          const m = mgr.arm({
            command: String(args.command),
            cwd,
            description: args.description ? String(args.description) : undefined,
            parentSessionId: context?.sessionID,
            readyPattern: args.ready_pattern,
            timeoutMs,
            steer: args.steer,
          })
          const bounds = persistent
            ? "session-length (no timeout)"
            : `timeout ${Math.round((timeoutMs ?? 0) / 1000)}s`
          const lines = [
            `<monitor_armed id="${m.id}">`,
            m.description ? `label: ${m.description}` : null,
            `command: ${m.command}`,
            `bounds: ${bounds}`,
            `delivery: ${m.steer ? "steering" : "serialized (one full agent response per event)"}`,
            `pid: ${m.pid ?? "?"}`,
            `parent_session: ${m.parentSessionId}`,
            `Matching stdout lines ${m.steer ? "steer active runs and wake idle sessions" : "wake this session one turn at a time"}. Use monitor_list / monitor_stop to observe or cancel.`,
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
  }
}

export const server: Plugin = async ({ client, directory }) => {
  const plugin = await createServerPlugin(v1Delivery(client), directory)
  return {
    tool: plugin.tool,
    event: async ({ event }) => {
      if (event.type === "session.deleted") plugin.mgr.cleanupBySession(event.properties.info.id)
      if (event.type === "server.instance.disposed") plugin.dispose()
    },
  }
}

async function setup(ctx: Context) {
  const plugin = await createServerPlugin(v2Delivery(ctx.session), ctx.location.directory)
  const abort = new AbortController()
  const dispose = () => {
    abort.abort()
    plugin.dispose()
  }
  try {
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(plugin.tool)) {
        editor.add({
          name,
          description: definition.description,
          input: tool.schema.object(definition.args),
          options: { codemode: false },
          execute: async (args, context) => {
            const result = await definition.execute(args as never, context as never)
            return { content: typeof result === "string" ? result : result.output }
          },
        })
      }
    })
    const events = ctx.event.subscribe({ signal: abort.signal })
    void (async () => {
      for await (const event of events) {
        if (event.type === "session.deleted") plugin.mgr.cleanupBySession(event.data.sessionID)
      }
    })().catch(() => {
      // The stream closes with the plugin's location scope. Reap its watchers.
      dispose()
    })
    return dispose
  } catch (error) {
    dispose()
    throw error
  }
}

// Each host selects its own entry point; both share tools and the watcher engine.
export default { id: ID, server, setup }
