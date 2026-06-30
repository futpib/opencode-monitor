import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createMonitorManager, type MonitorClient } from "../src/manager.ts"

const tmp = mkdtempSync(join(tmpdir(), "opencode-monitor-mgr-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid?: number) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const readPidSafe = (file: string): number | null => {
  try {
    const v = readFileSync(file, "utf8").trim()
    return v ? Number(v) : null
  } catch {
    return null
  }
}
const poll = async (fn: () => boolean, ms = 2500, step = 20): Promise<boolean> => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await sleep(step)
  }
  return false
}

interface Call {
  id: string
  text: string
}
function mockClient(): { client: MonitorClient; calls: Call[] } {
  const calls: Call[] = []
  const client: MonitorClient = {
    session: {
      prompt: async (o) => {
        calls.push({ id: o.path.id, text: o.body.parts[0]!.text })
        await sleep(5)
        return {}
      },
    },
  }
  return { client, calls }
}

test("persistent: each stdout line wakes the session in order, then an exit notice", async () => {
  const { client, calls } = mockClient()
  const mgr = createMonitorManager(client)
  const info = mgr.arm({ command: "echo one; echo two", parentSessionId: "ses_a" })
  assert.ok(await poll(() => calls.length >= 3), `only ${calls.length} wakes: ${JSON.stringify(calls)}`)
  assert.deepEqual(
    calls.map((c) => c.id),
    ["ses_a", "ses_a", "ses_a"],
  )
  assert.ok(calls[0]!.text.includes('<monitor id="') && calls[0]!.text.includes("one"))
  assert.ok(calls[1]!.text.includes("two"))
  assert.ok(calls[2]!.text.includes("command finished"))
  assert.equal(mgr.list().find((m) => m.id === info.id)?.status, "exited")
})

test("persistent: ready_pattern filters which lines wake", async () => {
  const { client, calls } = mockClient()
  const mgr = createMonitorManager(client)
  mgr.arm({ command: "echo skip; echo HIT; echo skip2", parentSessionId: "ses_b", readyPattern: "^HIT$" })
  assert.ok(await poll(() => calls.some((c) => c.text.includes("HIT"))))
  await sleep(200)
  const lineWakes = calls.filter((c) => c.text.includes(' line="'))
  assert.equal(lineWakes.length, 1)
  assert.ok(lineWakes[0]!.text.includes("HIT"))
})

test("stop reaps the process tree (grandchild dies) and is idempotent", async () => {
  const { client } = mockClient()
  const mgr = createMonitorManager(client)
  const pidfile = join(tmp, "stop.pid")
  const info = mgr.arm({ command: `sleep 30 & echo $! > "${pidfile}"; wait $!`, parentSessionId: "ses_c" })
  assert.ok(await poll(() => readPidSafe(pidfile) !== null))
  const pid = readPidSafe(pidfile)
  assert.equal(mgr.stop(info.id), true)
  assert.equal(mgr.stop(info.id), false)
  await sleep(500)
  assert.equal(alive(pid ?? undefined), false)
})

test("cleanupBySession stops only that session's monitors", async () => {
  const { client } = mockClient()
  const mgr = createMonitorManager(client)
  const a = mgr.arm({ command: "sleep 30", parentSessionId: "ses_a" })
  const b = mgr.arm({ command: "sleep 30", parentSessionId: "ses_b" })
  assert.equal(mgr.list().length, 2)
  const n = mgr.cleanupBySession("ses_a")
  assert.equal(n, 1)
  const remaining = mgr.list()
  assert.equal(remaining.length, 1)
  assert.equal(remaining[0]!.id, b.id)
  mgr.stop(b.id)
  void a
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
