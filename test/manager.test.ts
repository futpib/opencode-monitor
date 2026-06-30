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
  // monitors disappear from the registry once done
  assert.equal(mgr.list().find((m) => m.id === info.id), undefined, "monitor should be gone after exit")
})

test("persistent: description labels every wake and the exit notice", async () => {
  const { client, calls } = mockClient()
  const mgr = createMonitorManager(client)
  mgr.arm({ command: "echo hi", parentSessionId: "ses_d", description: "errors in app.log" })
  assert.ok(await poll(() => calls.length >= 2), `only ${calls.length} wakes`)
  assert.ok(calls[0]!.text.includes('label="errors in app.log"'), calls[0]!.text)
  assert.ok(calls[0]!.text.includes("hi"))
  assert.ok(calls[1]!.text.includes('label="errors in app.log"'), calls[1]!.text)
  assert.ok(calls[1]!.text.includes("command finished"))
})

test("timeout: a bounded monitor is reaped and emits a timed-out notice, then disappears", async () => {
  const { client, calls } = mockClient()
  const mgr = createMonitorManager(client)
  const pidfile = join(tmp, "tmout.pid")
  const info = mgr.arm({
    command: `sleep 30 & echo $! > "${pidfile}"; wait $!`,
    parentSessionId: "ses_t",
    description: "bounded watch",
    timeoutMs: 400,
  })
  assert.ok(await poll(() => calls.some((c) => c.text.includes("timed-out"))), "no timed-out notice")
  const notice = calls.find((c) => c.text.includes("timed-out"))!
  assert.ok(notice.text.includes('label="bounded watch"'), notice.text)
  assert.ok(notice.text.includes("stopped after"), notice.text)
  const pid = readPidSafe(pidfile)
  await sleep(500)
  assert.equal(alive(pid ?? undefined), false, `grandchild ${pid} survived timeout`)
  assert.equal(mgr.list().find((m) => m.id === info.id), undefined, "timed-out monitor should be gone")
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

test("subscribe: listeners fire on arm, stop, and line updates (throttled)", async () => {
  const { client } = mockClient()
  const mgr = createMonitorManager(client)
  let calls = 0
  const unsub = mgr.subscribe(() => { calls++ })

  const info = mgr.arm({ command: "echo a; echo b", parentSessionId: "ses_s" })
  assert.ok(await poll(() => calls >= 1), "subscribe did not fire on arm")
  const afterArm = calls
  assert.ok(await poll(() => calls > afterArm), "subscribe did not fire on line/exit updates")

  mgr.stop(info.id)
  assert.ok(await poll(() => false, 50).then(() => true)) // let notify settle
  await sleep(300)
  const beforeUnsub = calls
  unsub()
  mgr.arm({ command: "sleep 5", parentSessionId: "ses_s" })
  await sleep(300)
  assert.equal(calls, beforeUnsub, "unsubscribed listener still fired")
  mgr.stop(mgr.list()[0]!.id)
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
