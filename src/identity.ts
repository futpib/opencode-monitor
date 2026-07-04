import { createHash } from "node:crypto"
import { join } from "node:path"
import { createConnection } from "node:net"
import { readdirSync, unlinkSync } from "node:fs"

// Shared by the server plugin and the TUI plugin. Both sides derive socket
// locations from the worktree alone (the only identity they both reliably
// share), so the layout has to tolerate N concurrent opencode servers in the
// SAME worktree.
//
// Why per-server sockets: opencode can run more than one server process per
// worktree (e.g. one per launched TUI). Each server hosts its own in-memory
// monitor registry. If they all bind a single `status-<worktreeHash>.sock`,
// the second to start unlinks the first's socket out from under it and steals
// the path — the first server's monitors become unreachable via the path (the
// TUI always connects to the path's current owner) while their wake channel
// keeps working. One socket per server instance removes the collision.

export const SOCKET_DIR_NAME = "opencode-monitor"

export function worktreeHash(worktree: string): string {
  return createHash("sha256").update(worktree || "").digest("hex").slice(0, 16)
}

export function socketDir(): string {
  return join(process.env.XDG_RUNTIME_DIR || "/tmp", SOCKET_DIR_NAME)
}

/** Server side: a socket unique to one factory invocation (token = random). */
export function serverSocketPath(worktree: string, token: string): string {
  return join(socketDir(), `status-${worktreeHash(worktree)}-${token}.sock`)
}

/**
 * TUI side: enumerate every server's socket in this worktree. Returns the dir
 * and the prefix every live socket filename starts with. Callers list the dir
 * and keep names with `startsWith(prefix) && endsWith(".sock")`.
 */
export function worktreeSocketGlob(worktree: string): { dir: string; prefix: string } {
  return { dir: socketDir(), prefix: `status-${worktreeHash(worktree)}-` }
}

/**
 * Best-effort liveness check for a unix socket. Resolves true on connect,
 * false on error/timeout. Used to tell a dead (orphaned) socket file from one
 * a live server is listening on.
 */
export function socketAlive(path: string, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path)
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
      resolve(v)
    }
    s.on("connect", () => finish(true))
    s.on("error", () => finish(false))
    setTimeout(() => finish(false), timeoutMs)
  })
}

/**
 * Self-heal: remove orphaned socket files for this worktree left by servers
 * that crashed or restarted (and the legacy single-key `status-<hash>.sock`
 * from before per-server sockets). Only unlinks files no process is listening
 * on, so live servers (this one's siblings) are never touched. Safe to run on
 * every server start.
 */
export async function pruneDeadSockets(worktree: string): Promise<void> {
  const dir = socketDir()
  const legacy = `status-${worktreeHash(worktree)}.sock`
  const prefix = `status-${worktreeHash(worktree)}`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    // Match both legacy (status-<hash>.sock) and per-server (status-<hash>-<token>.sock).
    if (!(name === legacy || (name.startsWith(prefix) && name.endsWith(".sock")))) continue
    const p = join(dir, name)
    if (await socketAlive(p)) continue
    try {
      unlinkSync(p)
    } catch {
      /* raced or gone */
    }
  }
}
