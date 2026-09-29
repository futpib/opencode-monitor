import { Plugin } from "@opencode/plugin"
import { createServer, type Server, type Socket } from "node:net"
import { unlinkSync, mkdirSync } from "node:fs"
import { createMonitorManager } from "./manager.ts"
import { serverSocketPath, socketDir, pruneDeadSockets } from "./identity.ts"

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

export default Plugin.define({
  id: "opencode-monitor",
  async setup(ctx) {
    const directory = ctx.location.directory
    const mgr = createMonitorManager(ctx)
    const token = crypto.randomUUID().slice(0, 8)
    const sockPath = serverSocketPath(directory, token)
    const clients = new Set<Socket>()
    let socketServer: Server | undefined
    const snapshot = () => JSON.stringify({ updatedAt: Date.now(), monitors: mgr.list() }) + "\n"
    const send = (socket: Socket) => {
      try {
        socket.write(snapshot())
      } catch {
        clients.delete(socket)
      }
    }

    await pruneDeadSockets(directory)
    try {
      mkdirSync(socketDir(), { recursive: true, mode: 0o700 })
      unlinkSync(sockPath)
    } catch {
      // No stale socket (or the status socket is unavailable); tools still work.
    }
    try {
      socketServer = createServer((socket) => {
        clients.add(socket)
        send(socket)
        socket.on("error", () => clients.delete(socket))
        socket.on("close", () => clients.delete(socket))
      })
      socketServer.on("error", () => {})
      socketServer.listen(sockPath)
    } catch {
      // The status socket is best-effort; the monitor tools work without the panel.
    }
    const removeSocket = () => {
      try { unlinkSync(sockPath) } catch { /* already removed */ }
    }
    process.on("exit", removeSocket)
    const unsubscribe = mgr.subscribe(() => {
      for (const socket of clients) send(socket)
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "monitor",
        description: DESCRIPTION,
        input: {
          type: "object",
          properties: {
            description: { type: "string", description: "Short label shown in notifications and the sidebar." },
            command: { type: "string", description: "Long-lived shell command printing one event per stdout line." },
            persistent: { type: "boolean", description: "If true, watch for the whole session; otherwise use timeout_seconds." },
            ready_pattern: { type: "string", description: "Only wake on stdout lines matching this regex." },
            timeout_seconds: { type: "number", description: "Bounded watch timeout in seconds (default 300, max 3600)." },
            cwd: { type: "string", description: "Working directory. Defaults to the project directory." },
          },
          required: ["command"],
          additionalProperties: false,
        },
        async execute(input, context) {
          const args = input as {
            command: string; description?: string; persistent?: boolean
            ready_pattern?: string; timeout_seconds?: number; cwd?: string
          }
          const cwd = args.cwd ?? directory
          const persistent = Boolean(args.persistent)
          const timeoutMs = persistent ? undefined : clampTimeoutMs(args.timeout_seconds)
          const m = mgr.arm({
            command: args.command,
            cwd,
            description: args.description,
            parentSessionId: context.sessionID,
            readyPattern: args.ready_pattern,
            timeoutMs,
          })
          const bounds = persistent ? "session-length (no timeout)" : `timeout ${Math.round((timeoutMs ?? 0) / 1000)}s`
          return { content: [
            `<monitor_armed id="${m.id}">`,
            m.description ? `label: ${m.description}` : null,
            `command: ${m.command}`,
            `bounds: ${bounds}`,
            `pid: ${m.pid ?? "?"}`,
            `parent_session: ${m.parentSessionId}`,
            "Each stdout line wakes this session. Use monitor_list / monitor_stop to observe or cancel.",
            "</monitor_armed>",
          ].filter((line) => line !== null).join("\n") }
        },
      })
      editor.add({
        name: "monitor_list",
        description: "List active monitors armed via monitor (each runs until its command exits, times out, or is stopped).",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          const items = mgr.list()
          if (items.length === 0) return { content: "(no active monitors)" }
          return { content: [
            "active monitors:",
            ...items.map((m) => `- ${m.id}  ${m.description ? `${JSON.stringify(m.description)}  ` : ""}pid=${m.pid ?? "?"}  lines=${m.lineCount}  cmd=${JSON.stringify(m.command)}`),
          ].join("\n") }
        },
      })
      editor.add({
        name: "monitor_stop",
        description: "Stop and reap a monitor by id (the m_xxxx from monitor_list / monitor_armed).",
        input: { type: "object", properties: { id: { type: "string", description: "Monitor id, e.g. m_1a2b3c4d." } }, required: ["id"], additionalProperties: false },
        async execute(input) {
          const { id } = input as { id: string }
          return { content: mgr.stop(id) ? `stopped ${id}` : `no such monitor: ${id}` }
        },
      })
    })

    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          if (event.type === "session.deleted") mgr.cleanupBySession(event.data.sessionID)
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("opencode-monitor event subscription failed", error)
      }
    })()

    return () => {
      controller.abort()
      mgr.stopAll()
      unsubscribe()
      for (const socket of clients) socket.destroy()
      socketServer?.close()
      process.off("exit", removeSocket)
      removeSocket()
    }
  },
})
