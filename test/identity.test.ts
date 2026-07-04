import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  worktreeHash,
  serverSocketPath,
  worktreeSocketGlob,
  socketAlive,
  pruneDeadSockets,
} from "../src/identity.ts"

const XDG_BACK = process.env.XDG_RUNTIME_DIR
const tmp = mkdtempSync(join(tmpdir(), "opencode-monitor-id-"))
process.env.XDG_RUNTIME_DIR = tmp

test.after(() => {
  if (XDG_BACK === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = XDG_BACK
  rmSync(tmp, { recursive: true, force: true })
})

test("serverSocketPath is unique per server token in the same worktree", () => {
  const wt = "/home/claude"
  const a = serverSocketPath(wt, "111")
  const b = serverSocketPath(wt, "222")
  assert.notEqual(a, b, "two servers in one worktree must get distinct paths")
  assert.ok(a.endsWith("status-" + worktreeHash(wt) + "-111.sock"))
})

test("worktreeSocketGlob prefix matches every per-server socket and excludes legacy", () => {
  const wt = "/projects/x"
  const { prefix } = worktreeSocketGlob(wt)
  const h = worktreeHash(wt)
  assert.equal(prefix, `status-${h}-`)
  assert.ok(`${prefix}aaa.sock`.startsWith(prefix))
  // Legacy single-key file (pre-multi-server) must NOT match the new glob.
  assert.ok(!`status-${h}.sock`.startsWith(prefix))
})

test("socketAlive distinguishes a listening socket from a dead path", async () => {
  const { createServer } = await import("node:net")
  const path = join(tmp, "alive.sock")
  await new Promise<void>((res) => {
    const srv = createServer(() => {}).listen(path, res)
    test.after(() => srv.close())
  })
  assert.equal(await socketAlive(path), true)
  assert.equal(await socketAlive(join(tmp, "definitely-missing.sock")), false)
})

test("pruneDeadSockets removes dead sockets but leaves live ones", async () => {
  const { createServer } = await import("node:net")
  const { writeFileSync, mkdirSync, existsSync } = await import("node:fs")
  const wt = "/worktree/prune-test"
  const live = serverSocketPath(wt, "live")
  const dead = serverSocketPath(wt, "dead")
  const legacy = join(tmp, "opencode-monitor", `status-${worktreeHash(wt)}.sock`)
  mkdirSync(join(tmp, "opencode-monitor"), { recursive: true })
  const srv = createServer(() => {})
  await new Promise<void>((res) => srv.listen(live, res))
  // Touch a dead per-server file and a dead legacy file (no listener).
  writeFileSync(dead, "") // not a socket, just a dead path
  writeFileSync(legacy, "")

  await pruneDeadSockets(wt)

  assert.equal(existsSync(live), true, "live server socket must be preserved")
  assert.equal(existsSync(dead), false, "dead per-server file must be pruned")
  assert.equal(existsSync(legacy), false, "legacy dead file must be pruned")
  srv.close()
})
