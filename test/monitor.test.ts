import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runMonitor, formatResult } from "../src/monitor.ts"

const tmp = mkdtempSync(join(tmpdir(), "opencode-monitor-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number | undefined) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPid = (file: string) => Number(readFileSync(file, "utf8").trim())

test("exits 0 and captures stdout", async () => {
  const r = await runMonitor({ command: "echo hello", timeoutMs: 5000 })
  assert.equal(r.outcome, "exited")
  assert.equal(r.exitCode, 0)
  assert.ok(r.lines.includes("hello"))
})

test("captures a non-zero exit code", async () => {
  const r = await runMonitor({ command: "echo oops; exit 3", timeoutMs: 5000 })
  assert.equal(r.outcome, "exited")
  assert.equal(r.exitCode, 3)
})

test("returns early on ready_pattern", async () => {
  const t0 = Date.now()
  const r = await runMonitor({
    command: "echo a; sleep 0.2; echo b; sleep 0.2; echo READY; sleep 30",
    readyPattern: "READY",
    timeoutMs: 8000,
  })
  const elapsed = Date.now() - t0
  assert.equal(r.outcome, "ready")
  assert.equal(r.readyLine, "READY")
  assert.ok(elapsed < 2000, `took ${elapsed}ms`)
})

test("kills the whole tree on timeout (grandchild dies)", async () => {
  const pidfile = join(tmp, "timeout.pid")
  const r = await runMonitor({
    command: `sleep 30 & echo $! > "${pidfile}"; wait $!`,
    timeoutMs: 500,
  })
  assert.equal(r.outcome, "timeout")
  const sleepPid = readPid(pidfile)
  await sleep(500)
  assert.equal(alive(sleepPid), false, `grandchild ${sleepPid} survived`)
})

test("kills the whole tree on early ready return", async () => {
  const pidfile = join(tmp, "ready.pid")
  const r = await runMonitor({
    command: `sleep 30 & echo $! > "${pidfile}"; while :; do echo READY; sleep 0.3; done`,
    readyPattern: "^READY$",
    timeoutMs: 8000,
  })
  assert.equal(r.outcome, "ready")
  const sleepPid = readPid(pidfile)
  await sleep(500)
  assert.equal(alive(sleepPid), false, `grandchild ${sleepPid} survived`)
})

test("captures stderr with a distinct prefix", async () => {
  const r = await runMonitor({ command: "echo out; echo err >&2", timeoutMs: 5000 })
  assert.ok(r.lines.includes("out"))
  assert.ok(r.lines.some((l) => l === "[stderr] err"))
})

test("keeps a trailing partial line", async () => {
  const r = await runMonitor({ command: "printf partial", timeoutMs: 5000 })
  assert.ok(r.lines.includes("partial"))
})

test("applies a ring buffer at maxLines", async () => {
  const r = await runMonitor({
    command: "for i in $(seq 1 50); do echo line$i; done",
    timeoutMs: 5000,
    maxLines: 10,
  })
  assert.equal(r.truncated, true)
  assert.equal(r.lines.length, 10)
  assert.equal(r.lines.at(-1), "line50")
})

test("an invalid ready_pattern is ignored, not fatal", async () => {
  const r = await runMonitor({ command: "echo hi", readyPattern: "(", timeoutMs: 5000 })
  assert.equal(r.outcome, "exited")
  assert.equal(r.exitCode, 0)
})

test("formatResult renders meta + body", () => {
  const out = formatResult({
    outcome: "ready",
    exitCode: null,
    readyLine: "READY",
    elapsedMs: 1234,
    truncated: false,
    lines: ["READY", "next"],
  })
  assert.match(out, /outcome=ready/)
  assert.match(out, /ready_line="READY"/)
  assert.match(out, /elapsed=1\.2s/)
  assert.ok(out.includes("next"))
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
