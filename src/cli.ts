#!/usr/bin/env node
import { runMonitor, formatResult, type MonitorResult } from "./monitor.ts"

interface CliOptions {
  command: string
  readyPattern?: string
  timeoutMs: number
  cwd?: string
  maxLines?: number
  json: boolean
}

function usage(): never {
  process.stderr.write(
    [
      "opencode-monitor — block on an external condition, then return",
      "",
      "usage: opencode-monitor <command> [options]",
      "",
      "options:",
      "  --ready <regex>       return as soon as a stdout line matches",
      "  --timeout <seconds>   max wait (default 600, cap 3600)",
      "  --cwd <dir>           working directory",
      "  --max-lines <n>       output buffer cap (default 500)",
      "  --json                emit the result as JSON",
      "  -h, --help            show this help",
      "",
    ].join("\n"),
  )
  process.exit(2)
}

function parse(argv: string[]): CliOptions {
  const opts: CliOptions = { command: "", timeoutMs: 600_000, json: false }
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) usage()
      return v
    }
    if (a === "-h" || a === "--help") usage()
    else if (a === "--ready") opts.readyPattern = next()
    else if (a === "--timeout") opts.timeoutMs = (Number(next()) || 600) * 1000
    else if (a === "--cwd") opts.cwd = next()
    else if (a === "--max-lines") opts.maxLines = Number(next()) || undefined
    else if (a === "--json") opts.json = true
    else if (a.startsWith("--")) usage()
    else positional.push(a)
  }
  opts.command = positional.join(" ")
  return opts
}

async function main(): Promise<void> {
  const opts = parse(process.argv.slice(2))
  if (!opts.command) usage()
  const result: MonitorResult = await runMonitor({
    command: opts.command,
    cwd: opts.cwd,
    readyPattern: opts.readyPattern,
    timeoutMs: Math.min(Math.max(opts.timeoutMs, 1000), 3_600_000),
    maxLines: opts.maxLines,
  })
  if (opts.json) process.stdout.write(JSON.stringify(result) + "\n")
  else process.stdout.write(formatResult(result) + "\n")
  process.exit(result.outcome === "timeout" ? 124 : result.exitCode ?? 0)
}

void main()
