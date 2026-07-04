import { createSignal, For, Show } from "solid-js"
import { createConnection, type Socket } from "node:net"
import { readdirSync, existsSync } from "node:fs"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { worktreeSocketGlob } from "./identity.js"

interface MonInfo {
  id: string
  command: string
  cwd?: string
  description?: string
  parentSessionId: string
  status: string
  pid: number | null
  exitCode: number | null
  createdAt: number
  lineCount: number
  lastLine: string | null
}

function age(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h${m % 60}m`
}

export const tui: TuiPlugin = async (api) => {
  const [mons, setMons] = createSignal<MonInfo[]>([])
  // Collapse state mirrors opencode's built-in MCP panel: a local signal
  // (default expanded), toggled by clicking the header. Lives at plugin scope so
  // it survives slot re-renders.
  const [open, setOpen] = createSignal(true)

  // Fan out across every status socket in this worktree. The plugin server
  // factory can run more than once per opencode process (hot-reload), and there
  // may be multiple server processes per worktree — each invocation hosts its
  // own monitor registry on its own socket (status-<worktreeHash>-<token>.sock,
  // token random per invocation). We connect to all of them, keep a per-socket
  // slice, and merge — so a monitor armed in any engine shows up here. The
  // session_id filter in the panel scopes display.
  const { dir, prefix } = worktreeSocketGlob(api.state.path.directory)
  const slices = new Map<string, MonInfo[]>()
  let stopped = false
  const conns = new Map<string, Socket>()

  const merge = () => setMons([...slices.values()].flat())

  const connectOne = (path: string) => {
    if (stopped || conns.has(path)) return
    let buf = ""
    let armed = false
    const sock = createConnection(path)
    const cleanup = () => {
      conns.delete(path)
      // Only drop the slice if the socket file is gone (server exited); a
      // transient error on a live socket keeps its last snapshot until reconnect.
      if (!existsSync(path)) {
        slices.delete(path)
        merge()
      }
    }
    const reopen = () => {
      if (armed || stopped) return
      armed = true
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
      cleanup()
      // Re-attempt shortly; rescan() also re-discovers on its own cadence.
      setTimeout(() => connectOne(path), 1500)
    }
    sock.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        try {
          const parsed = JSON.parse(line)
          if (Array.isArray(parsed?.monitors)) {
            slices.set(path, parsed.monitors as MonInfo[])
            merge()
          }
        } catch {
          /* partial / non-json line */
        }
      }
    })
    sock.on("error", () => reopen())
    sock.on("close", () => reopen())
    conns.set(path, sock)
  }

  // Discover sockets present now and re-scan periodically so servers started
  // after the TUI are picked up, and vanished socket files are dropped.
  const rescan = () => {
    if (stopped) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    const live = new Set<string>()
    for (const name of names) {
      if (!name.startsWith(prefix) || !name.endsWith(".sock")) continue
      const path = `${dir}/${name}`
      live.add(path)
      connectOne(path)
    }
    // Drop connections whose socket file disappeared.
    for (const path of [...conns.keys()]) {
      if (!live.has(path)) {
        try {
          conns.get(path)?.destroy()
        } catch {
          /* ignore */
        }
        conns.delete(path)
        slices.delete(path)
      }
    }
    merge()
  }
  rescan()
  const scanTimer = setInterval(rescan, 3000)
  scanTimer.unref?.()

  api.lifecycle.onDispose(() => {
    stopped = true
    clearInterval(scanTimer)
    for (const s of conns.values()) {
      try {
        s.destroy()
      } catch {
        /* ignore */
      }
    }
    conns.clear()
  })

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        const theme = api.theme.current
        // Only this session's monitors matter; the fan-in still connects every
        // engine (a monitor for this session may live in any of them), but we
        // display and count just the current session.
        const here = mons().filter((m) => m.parentSessionId === props.session_id)

        return (
          <box flexDirection="column" gap={0}>
            <box
              flexDirection="row"
              gap={1}
              onMouseDown={() => here.length > 0 && setOpen((x) => !x)}
            >
              <Show when={here.length > 0}>
                <text fg={theme.text}>{open() ? "▼" : "▶"}</text>
              </Show>
              <text fg={theme.text}>
                <b>Monitors</b>
              </text>
              <text fg={theme.textMuted}>({here.length})</text>
            </box>

            <Show when={open()}>
              <Show when={here.length === 0}>
                <text fg={theme.textMuted}>no active monitors</text>
              </Show>

              <For each={here}>
                {(m) => (
                  <box flexDirection="column" gap={0}>
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.success}>●</text>
                      <text fg={theme.text}>{m.description ?? m.id}</text>
                      <Show when={m.description}>
                        <text fg={theme.textMuted}>{m.id}</text>
                      </Show>
                    </box>
                    <text fg={theme.textMuted}>{m.command}</text>
                    <text fg={theme.textMuted}>
                      lines={m.lineCount} pid={m.pid ?? "?"} age={age(m.createdAt)}
                    </text>
                    <Show when={m.lastLine}>
                      <text fg={theme.textMuted}>└ {m.lastLine}</text>
                    </Show>
                  </box>
                )}
              </For>
            </Show>
          </box>
        )
      },
    },
  } as never)

  return undefined
}

export default { id: "opencode-monitor", tui }
