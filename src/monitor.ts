import { spawn, execSync, type ChildProcess } from "node:child_process"

export type MonitorOutcome = "ready" | "exited" | "timeout"

export interface MonitorOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
  readyPattern?: string
  timeoutMs: number
  maxLines?: number
}

export interface MonitorResult {
  outcome: MonitorOutcome
  exitCode: number | null
  readyLine: string | null
  elapsedMs: number
  truncated: boolean
  lines: string[]
}

const DEFAULT_MAX_LINES = 500

let cachedSetsid: string | null | undefined
function setsidBin(): string | null {
  if (cachedSetsid !== undefined) return cachedSetsid
  if (process.platform === "win32") return (cachedSetsid = null)
  try {
    const out = execSync("command -v setsid", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim()
    cachedSetsid = out || null
  } catch {
    cachedSetsid = null
  }
  return cachedSetsid
}

function spawnChild(opts: MonitorOptions): ChildProcess {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env
  const stdio: Array<"ignore" | "pipe"> = ["ignore", "pipe", "pipe"]
  if (process.platform === "win32") {
    const comspec = process.env.ComSpec || "cmd.exe"
    return spawn(comspec, ["/d", "/s", "/c", opts.command], { cwd: opts.cwd, env, stdio })
  }
  const setsid = setsidBin()
  if (setsid) {
    return spawn(setsid, ["-w", "/bin/sh", "-c", opts.command], { cwd: opts.cwd, env, stdio })
  }
  return spawn("/bin/sh", ["-c", opts.command], { cwd: opts.cwd, env, stdio, detached: true })
}

function reap(child: ChildProcess): void {
  const signal = (sig: NodeJS.Signals) => {
    if (!child.pid) return
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" })
      } else {
        process.kill(-child.pid, sig)
      }
    } catch {
      try {
        child.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }
  signal("SIGTERM")
  const hard = setTimeout(() => signal("SIGKILL"), 200)
  hard.unref?.()
}

function attachLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return
  let buf = ""
  const drain = (eof: boolean) => {
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "")
      buf = buf.slice(i + 1)
      onLine(line)
    }
    if (eof && buf.length) {
      onLine(buf.replace(/\r$/, ""))
      buf = ""
    }
  }
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf8")
    drain(false)
  })
  stream.on("end", () => drain(true))
}

export async function runMonitor(opts: MonitorOptions): Promise<MonitorResult> {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES
  const started = Date.now()
  const lines: string[] = []
  let truncated = false
  let readyLine: string | null = null

  let pattern: RegExp | null = null
  if (opts.readyPattern) {
    try {
      pattern = new RegExp(opts.readyPattern)
    } catch {
      pattern = null
    }
  }

  const child = spawnChild(opts)

  let settled = false
  let resolve!: (r: MonitorResult) => void
  const done = new Promise<MonitorResult>((res) => {
    resolve = res
  })

  const finish = (outcome: MonitorOutcome, exitCode: number | null) => {
    if (settled) return
    settled = true
    resolve({
      outcome,
      exitCode,
      readyLine,
      elapsedMs: Date.now() - started,
      truncated,
      lines: lines.slice(),
    })
  }

  const push = (stream: "stdout" | "stderr", text: string) => {
    const stamped = stream === "stderr" ? `[stderr] ${text}` : text
    if (lines.length >= maxLines) {
      lines.shift()
      truncated = true
    }
    lines.push(stamped)
    if (stream === "stdout" && pattern && readyLine === null && pattern.test(text)) {
      readyLine = text
      finish("ready", null)
    }
  }

  attachLines(child.stdout, (t) => push("stdout", t))
  attachLines(child.stderr, (t) => push("stderr", t))
  child.on("error", () => finish("exited", null))
  child.on("close", (code) => finish("exited", code))

  const timer = setTimeout(() => finish("timeout", null), opts.timeoutMs)
  timer.unref?.()

  try {
    return await done
  } finally {
    clearTimeout(timer)
    reap(child)
  }
}

export function formatResult(r: MonitorResult): string {
  const meta = [
    `outcome=${r.outcome}`,
    r.exitCode === null ? null : `exit_code=${r.exitCode}`,
    r.readyLine === null ? null : `ready_line=${JSON.stringify(r.readyLine)}`,
    `elapsed=${(r.elapsedMs / 1000).toFixed(1)}s`,
    r.truncated ? `truncated=last_${r.lines.length}_lines` : null,
  ]
    .filter(Boolean)
    .join("  ")
  const body = r.lines.join("\n").trim() || "(no output)"
  return `${meta}\n${body}`
}
