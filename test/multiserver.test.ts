import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, createConnection, type Socket } from "node:net"
import { serverSocketPath, worktreeSocketGlob, pruneDeadSockets, socketDir } from "../src/identity.ts"

// Reproduces the original failure: two opencode server processes in the SAME
// worktree. Under the old single-socket design the second server's unlinkSync
// stole the path and a TUI connecting to the path saw only the second server's
// (empty) registry. Here each server binds its own per-server socket and a fan-in
// consumer (the TUI's shape) discovers and merges both.

const XDG_BACK = process.env.XDG_RUNTIME_DIR
const tmp = mkdtempSync(join(tmpdir(), "opencode-monitor-multi-"))
process.env.XDG_RUNTIME_DIR = tmp
test.after(() => {
  if (XDG_BACK === undefined) delete process.env.XDG_RUNTIME_DIR
  else process.env.XDG_RUNTIME_DIR = XDG_BACK
  rmSync(tmp, { recursive: true, force: true })
})

interface FakeServer {
  path: string
  close: () => void
  setMonitors: (ids: string[]) => void
}

// Mirrors src/server.ts: a status socket that pushes a JSON snapshot on connect
// and on every change.
function startServer(worktree: string, token: string, ids: string[]): FakeServer {
  mkdirSync(socketDir(), { recursive: true })
  const path = serverSocketPath(worktree, token)
  const clients = new Set<Socket>()
  const snapshot = () => JSON.stringify({ monitors: ids.map((id) => ({ id, parentSessionId: id })) }) + "\n"
  const srv = createServer((s) => {
    clients.add(s)
    s.write(snapshot())
    s.on("close", () => clients.delete(s))
    s.on("error", () => clients.delete(s))
  })
  srv.listen(path)
  return {
    path,
    close: () => srv.close(),
    setMonitors: (next: string[]) => {
      ids = next
      for (const c of clients) c.write(snapshot())
    },
  }
}

// Mirrors the TUI fan-in (src/tui.tsx): glob the worktree's sockets, connect to
// each, collect one snapshot per socket, merge.
async function fanIn(worktree: string, timeoutMs = 1000): Promise<{ id: string }[]> {
  const { dir, prefix } = worktreeSocketGlob(worktree)
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix) && n.endsWith(".sock"))
  } catch {
    return []
  }
  const merged: { id: string }[] = []
  await Promise.all(
    names.map(
      (n) =>
        new Promise<void>((resolve) => {
          const sock = createConnection(join(dir, n))
          let buf = ""
          sock.on("data", (chunk: Buffer) => {
            buf += chunk.toString()
            let nl: number
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl)
              buf = buf.slice(nl + 1)
              try {
                const parsed = JSON.parse(line)
                if (Array.isArray(parsed?.monitors)) merged.push(...parsed.monitors)
              } catch {
                /* partial */
              }
            }
            sock.destroy()
          })
          sock.on("error", () => resolve())
          sock.on("close", () => resolve())
          setTimeout(() => {
            sock.destroy()
            resolve()
          }, timeoutMs)
        }),
    ),
  )
  return merged
}

test("two servers in one worktree: fan-in sees BOTH registries (regression for the stolen-socket bug)", async () => {
  const wt = "/home/claude"
  await pruneDeadSockets(wt)
  const a = startServer(wt, "111", ["monitor-from-server-A"])
  const b = startServer(wt, "222", ["monitor-from-server-B"])

  assert.notEqual(a.path, b.path, "servers must bind distinct socket paths")

  const seen = await fanIn(wt)
  const ids = seen.map((m) => m.id).sort()
  assert.deepEqual(ids, ["monitor-from-server-A", "monitor-from-server-B"])

  a.close()
  b.close()
})

test("a server started AFTER the first is still discovered by the glob", async () => {
  const wt = "/projects/late"
  await pruneDeadSockets(wt)
  const a = startServer(wt, "first", ["early"])
  let seen = await fanIn(wt)
  assert.deepEqual(seen.map((m) => m.id), ["early"])

  const b = startServer(wt, "second", ["late"])
  seen = await fanIn(wt)
  assert.deepEqual(seen.map((m) => m.id).sort(), ["early", "late"])

  a.close()
  b.close()
})

test("two factory invocations in the same worktree (hot-reload) both stay reachable", async () => {
  // Regression: with a pid token, the 2nd invocation unlinked+rebound the same
  // path, orphaning the 1st engine (and its armed monitors) off the filesystem.
  // With a per-invocation token each keeps its own file and the fan-in sees both.
  const wt = "/home/claude"
  await pruneDeadSockets(wt)
  const a = startServer(wt, "invoc1", ["armed-before-reload"])
  const b = startServer(wt, "invoc2", ["armed-after-reload"])
  assert.notEqual(a.path, b.path, "invocations must get distinct paths")
  const seen = await fanIn(wt)
  assert.deepEqual(
    seen.map((m) => m.id).sort(),
    ["armed-after-reload", "armed-before-reload"],
  )
  a.close()
  b.close()
})

test("a crashed server's orphan socket is pruned on the next start", async () => {
  const wt = "/projects/crash"
  await pruneDeadSockets(wt)
  mkdirSync(socketDir(), { recursive: true })
  // Simulate a crash: a per-server socket file with no listener (a process that
  // died without unlinking). Plus a live server that should be preserved.
  const orphanPath = serverSocketPath(wt, "dead")
  writeFileSync(orphanPath, "")
  const live = startServer(wt, "alive", ["y"])
  assert.equal(existsSync(orphanPath), true, "orphan file should exist before prune")
  await pruneDeadSockets(wt)
  assert.equal(existsSync(orphanPath), false, "dead orphan should be pruned")
  assert.equal(existsSync(live.path), true, "live server socket must be preserved")
  live.close()
})
