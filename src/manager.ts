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
}

export type MonitorStatus = "running" | "exited" | "killed" | "error"

export interface MonitorInfo {
  id: string
  command: string
  cwd?: string
  parentSessionId: string
  status: MonitorStatus
  pid: number | null
  exitCode: number | null
  createdAt: number
  lineCount: number
  lastLine: string | null
}

interface Monitor extends MonitorInfo {
  child: ChildProcess | null
  abort: AbortController
  enqueue: (fn: () => Promise<void>) => void
}

export interface MonitorManager {
  arm: (opts: ArmOptions) => MonitorInfo
  stop: (id: string) => boolean
  list: () => MonitorInfo[]
  cleanupBySession: (parentSessionId: string) => number
  subscribe: (cb: () => void) => () => void
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

    const forward = async (line: string, stream: "stdout" | "stderr") => {
      if (mon.abort.signal.aborted) return
      mon.lineCount += 1
      mon.lastLine = stream === "stderr" ? `[stderr] ${line}` : line
      notifyThrottled()
      if (stream === "stderr") return
      if (pattern && !pattern.test(line)) return
      const text = `<monitor id="${id}" line="${mon.lineCount}">\n${line}\n</monitor>`
      try {
        await wake(mon.parentSessionId, text)
      } catch {
        /* session gone or busy; leave for next line / backstop */
      }
    }

    attachLines(child.stdout, (line) => enqueue(() => forward(line, "stdout")))
    attachLines(child.stderr, (line) => enqueue(() => forward(line, "stderr")))

    child.on("error", () => {
      mon.status = "error"
      notify()
    })
    child.on("close", (code) => {
      if (mon.status === "running") {
        mon.status = "exited"
        mon.exitCode = code ?? null
      }
      notify()
      enqueue(async () => {
        if (mon.abort.signal.aborted) return
        const text = `<monitor id="${id}" exited code="${code ?? 0}">command finished after ${mon.lineCount} line(s); last: ${JSON.stringify(mon.lastLine)}</monitor>`
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
  const { child: _child, abort: _abort, enqueue: _enqueue, ...rest } = mon
  return rest
}
