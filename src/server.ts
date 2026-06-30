import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { createServer, type Socket } from "node:net"
import { unlinkSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import { join, dirname } from "node:path"
import { runMonitor, formatResult } from "./monitor.ts"
import { createMonitorManager } from "./manager.ts"

const ID = "opencode-monitor"

// MUST stay byte-identical to the twin in src/tui.tsx — both sides derive the
// same socket path from the worktree so the TUI connects to its own server.
export function statusSocketPath(worktree: string): string {
  const dir = process.env.XDG_RUNTIME_DIR || "/tmp"
  const h = createHash("sha256").update(worktree || "").digest("hex").slice(0, 16)
  return join(dir, "opencode-monitor", `status-${h}.sock`)
}

const DESCRIPTION = `Block on, or watch, an external condition without spending agent turns. Runs a shell command and parks the agent (near-zero cost) until there is signal.

Modes:
- one-shot (persistent=false, default): the command blocks until the condition is met then exits; the tool returns on exit, on a stdout line matching ready_pattern, or on timeout. Use this for "wait for X then continue".
- persistent (persistent=true): the command stays alive and EACH stdout line is pushed back into the session as a new turn (a <monitor> notification), so the agent is woken per event without re-arming. Returns immediately with a monitor id. Use monitor_list / monitor_stop to observe or cancel. This is the streaming-wake counterpart of a long-lived watcher (e.g. tailing a log or a message queue).

Use this INSTEAD of polling in a loop or sleep.

Examples:
- wait for a port:  while ! curl -sf localhost:3000/health; do sleep 1; done
- wait for a file:  while [ ! -f build/done ]; do sleep 1; done
- watch a log persistently:  persistent=true, command="tail -n0 -f app.log", ready_pattern="READY|ERROR"
- react to each event:  persistent=true, command="<your watcher that prints one line per event>"`

export const server: Plugin = async ({ client, directory }) => {
  const mgr = createMonitorManager(client)

  // Status socket: push the live registry to any connected TUI. Keyed by
  // worktree so each opencode server (one per project) owns its own socket —
  // no cross-instance clobber, no file, true backend state. opencode provides
  // no in-band plugin server->TUI channel, so this out-of-band socket is the
  // conventional status-endpoint pattern.
  const sockPath = statusSocketPath(directory)
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
  try {
    unlinkSync(sockPath)
  } catch {
    /* no stale socket */
  }
  try {
    mkdirSync(dirname(sockPath), { recursive: true })
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
  mgr.subscribe(() => {
    for (const s of clients) send(s)
  })

  return {
    tool: {
      monitor: tool({
        description: DESCRIPTION,
        args: {
          command: tool.schema
            .string()
            .describe("Shell command. One-shot: blocks until the condition is met then exits. Persistent: a long-lived process that prints one event per stdout line."),
          persistent: tool.schema
            .boolean()
            .optional()
            .describe("If true, keep the command alive and wake the session on each stdout line (returns immediately with a monitor id). Default false (one-shot, blocking)."),
          ready_pattern: tool.schema
            .string()
            .optional()
            .describe("One-shot: return as soon as a stdout line matches. Persistent: only wake on lines matching this regex (wake on every line if omitted)."),
          timeout_seconds: tool.schema
            .number()
            .optional()
            .describe("One-shot only: max seconds to wait. Default 600, capped at 3600. Ignored when persistent."),
          cwd: tool.schema
            .string()
            .optional()
            .describe("Working directory. Defaults to the project directory."),
        },
        async execute(args: any, context: any) {
          const cwd = args.cwd ?? context?.directory
          if (args.persistent) {
            const m = mgr.arm({
              command: String(args.command),
              cwd,
              parentSessionId: context?.sessionID,
              readyPattern: args.ready_pattern,
            })
            return [
              `<monitor_armed id="${m.id}">`,
              `command: ${m.command}`,
              `pid: ${m.pid ?? "?"}`,
              `parent_session: ${m.parentSessionId}`,
              `Each stdout line wakes this session. Use monitor_list / monitor_stop to observe or cancel.`,
              `</monitor_armed>`,
            ].join("\n")
          }
          const requested = Math.floor(Number(args?.timeout_seconds ?? 600)) || 600
          const timeoutSeconds = Math.min(Math.max(requested, 1), 3600)
          const result = await runMonitor({
            command: String(args.command),
            cwd,
            readyPattern: args.ready_pattern,
            timeoutMs: timeoutSeconds * 1000,
          })
          return formatResult(result)
        },
      }),

      monitor_list: tool({
        description: "List active persistent monitors armed via monitor(persistent=true).",
        args: {},
        async execute() {
          const items = mgr.list()
          if (items.length === 0) return "(no active monitors)"
          return [
            "active monitors:",
            ...items.map(
              (m) =>
                `- ${m.id}  status=${m.status}  pid=${m.pid ?? "?"}  lines=${m.lineCount}  cmd=${JSON.stringify(m.command)}`,
            ),
          ].join("\n")
        },
      }),

      monitor_stop: tool({
        description: "Stop and reap a persistent monitor by id (the m_xxxx from monitor_list / monitor_armed).",
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
