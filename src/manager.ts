import { type ChildProcess } from "node:child_process"
import { spawnMonitored, reap, attachLines } from "./monitor.ts"

export interface MonitorClient {
  session: {
    prompt: (opts: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
    }) => Promise<unknown>
  }
}

export interface ArmOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  parentSessionId: string
  readyPattern?: string
  description?: string
  /** When set, the watch is auto-stopped (reaped) after this many ms. */
  timeoutMs?: number
}

export type MonitorStatus = "running" | "exited" | "killed" | "error"

export interface MonitorInfo {
  id: string
  command: string
  cwd?: string
  description?: string
  parentSessionId: string
  status: MonitorStatus
  pid: number | null
  exitCode: number | null
  createdAt: number
  lineCount: number
  lastLine: string | null
}

type EndReason = "timeout" | "error"

interface Monitor extends MonitorInfo {
  child: ChildProcess | null
  abort: AbortController
  enqueue: (fn: () => Promise<void>) => void
  endedBy?: EndReason
  timeoutTimer?: ReturnType<typeof setTimeout>
}

export interface MonitorManager {
  arm: (opts: ArmOptions) => MonitorInfo
  stop: (id: string) => boolean
  list: () => MonitorInfo[]
  cleanupBySession: (parentSessionId: string) => number
  subscribe: (cb: () => void) => () => void
}

function attr(s?: string): string {
  if (!s) return ""
  return s.replace(/["\n\r]/g, " ").trim().slice(0, 80)
}

export function createMonitorManager(client: MonitorClient): MonitorManager {
  const monitors = new Map<string, Monitor>()

  const listeners = new Set<() => void>()
  let lineTimer: ReturnType<typeof setTimeout> | null = null
  const notify = () => {
    for (const cb of listeners) {
      try {
        cb()
      } catch {
        /* a bad listener must not break the others */
      }
    }
  }
  const notifyThrottled = () => {
    if (lineTimer) return
    lineTimer = setTimeout(() => {
      lineTimer = null
      notify()
    }, 250)
  }
  const subscribe = (cb: () => void) => {
    listeners.add(cb)
    return () => listeners.delete(cb)
  }

  const newId = (): string => {
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    return `m_${hex}`
  }

  const wake = async (sessionId: string, text: string): Promise<void> => {
    await client.session.prompt({
      path: { id: sessionId },
      body: { parts: [{ type: "text", text }] },
    })
  }

  const arm = (opts: ArmOptions): MonitorInfo => {
    const id = newId()
    const child = spawnMonitored({ command: opts.command, cwd: opts.cwd, env: opts.env })

    let pattern: RegExp | null = null
    if (opts.readyPattern) {
      try {
        pattern = new RegExp(opts.readyPattern)
      } catch {
        pattern = null
      }
    }

    let chain: Promise<void> = Promise.resolve()
    const enqueue = (fn: () => Promise<void>) => {
      chain = chain.then(fn, () => undefined)
    }

    const mon: Monitor = {
      id,
      command: opts.command,
      cwd: opts.cwd,
      description: opts.description,
      parentSessionId: opts.parentSessionId,
      status: "running",
      pid: child.pid ?? null,
      exitCode: null,
      createdAt: Date.now(),
      lineCount: 0,
      lastLine: null,
      child,
      abort: new AbortController(),
      enqueue,
    }
    monitors.set(id, mon)
    notify()

    const label = attr(mon.description) ? ` label="${attr(mon.description)}"` : ""

    const forward = async (line: string, stream: "stdout" | "stderr") => {
      if (mon.abort.signal.aborted) return
      mon.lineCount += 1
      mon.lastLine = stream === "stderr" ? `[stderr] ${line}` : line
      notifyThrottled()
      if (stream === "stderr") return
      if (pattern && !pattern.test(line)) return
      const text = `<monitor id="${id}" line="${mon.lineCount}"${label}>\n${line}\n</monitor>`
      try {
        await wake(mon.parentSessionId, text)
      } catch {
        /* session gone or busy; leave for next line / backstop */
      }
    }

    attachLines(child.stdout, (line) => enqueue(() => forward(line, "stdout")))
    attachLines(child.stderr, (line) => enqueue(() => forward(line, "stderr")))

    // Bounded watch: auto-stop after timeoutMs (only when not persistent).
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      mon.timeoutTimer = setTimeout(() => {
        mon.endedBy = "timeout"
        if (mon.child) reap(mon.child)
      }, opts.timeoutMs)
      mon.timeoutTimer.unref?.()
    }

    child.on("error", () => {
      mon.endedBy = "error"
    })

    child.on("close", (code) => {
      if (mon.timeoutTimer) {
        clearTimeout(mon.timeoutTimer)
        mon.timeoutTimer = undefined
      }
      enqueue(async () => {
        // Killed explicitly via stop()/cleanupBySession: it already removed
        // itself and set abort — emit no notice, don't double-delete.
        if (mon.abort.signal.aborted) return
        if (mon.status === "running") {
          mon.status = "exited"
          mon.exitCode = code ?? null
        }
        // Disappear when done: drop from the registry FIRST so the sidebar
        // and monitor_list reflect the end immediately. The notice below uses
        // already-captured fields, so it is unaffected by the removal.
        monitors.delete(id)
        notify()
        const secs = Math.max(0, Math.round((Date.now() - mon.createdAt) / 1000))
        let tag: string
        let detail: string
        if (mon.endedBy === "timeout") {
          tag = "timed-out"
          detail = `stopped after ${secs}s`
        } else if (mon.endedBy === "error") {
          tag = "errored"
          detail = "command failed to run"
        } else {
          tag = `exited code="${code ?? 0}"`
          detail = `command finished after ${mon.lineCount} line(s); last: ${JSON.stringify(mon.lastLine)}`
        }
        const text = `<monitor id="${id}" ${tag}${label}>${detail}</monitor>`
        try {
          await wake(mon.parentSessionId, text)
        } catch {
          /* session gone */
        }
      })
    })

    return info(mon)
  }

  const stop = (id: string): boolean => {
    const mon = monitors.get(id)
    if (!mon) return false
    mon.abort.abort()
    if (mon.timeoutTimer) {
      clearTimeout(mon.timeoutTimer)
      mon.timeoutTimer = undefined
    }
    if (mon.child) reap(mon.child)
    mon.status = "killed"
    monitors.delete(id)
    notify()
    return true
  }

  const list = (): MonitorInfo[] => Array.from(monitors.values()).map(info)

  const cleanupBySession = (parentSessionId: string): number => {
    let n = 0
    for (const id of [...monitors.keys()]) {
      const mon = monitors.get(id)!
      if (mon.parentSessionId === parentSessionId) {
        stop(id)
        n += 1
      }
    }
    notify()
    return n
  }

  return { arm, stop, list, cleanupBySession, subscribe }
}

function info(mon: Monitor): MonitorInfo {
  const { child: _child, abort: _abort, enqueue: _enqueue, endedBy: _endedBy, timeoutTimer: _timeoutTimer, ...rest } = mon
  return rest
}
