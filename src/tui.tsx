import { createSignal, For, Show } from "solid-js"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import type { TuiPlugin } from "@opencode-ai/plugin/tui"

interface MonInfo {
  id: string
  command: string
  cwd?: string
  parentSessionId: string
  status: string
  pid: number | null
  exitCode: number | null
  createdAt: number
  lineCount: number
  lastLine: string | null
}

function statePath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "opencode-monitor", "state.json")
}

function readMonitors(): MonInfo[] {
  try {
    const raw = readFileSync(statePath(), "utf8")
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed?.monitors) ? (parsed.monitors as MonInfo[]) : []
  } catch {
    return []
  }
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
  const [mons, setMons] = createSignal<MonInfo[]>(readMonitors())

  const timer = setInterval(() => setMons(readMonitors()), 1000)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 250,
    slots: {
      sidebar_content(_ctx: unknown, props: { session_id: string }) {
        const theme = api.theme.current
        const list = mons()
        const here = list.filter((m) => m.parentSessionId === props.session_id)
        const other = list.length - here.length

        const colorFor = (s: string) =>
          s === "running"
            ? theme.success
            : s === "exited"
              ? theme.textMuted
              : theme.warning

        return (
          <box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>Monitors</text>
              <text fg={theme.textMuted}>({list.length})</text>
            </box>

            <Show when={list.length === 0}>
              <text fg={theme.textMuted}>no active monitors</text>
            </Show>

            <For each={list}>
              {(m) => (
                <box flexDirection="column" gap={0}>
                  <box flexDirection="row" gap={1}>
                    <text fg={colorFor(m.status)}>{m.status === "running" ? "●" : "○"}</text>
                    <text fg={theme.text}>{m.id}</text>
                    <text fg={theme.textMuted}>{m.status}</text>
                  </box>
                  <text fg={theme.textMuted}>{m.command}</text>
                  <text fg={theme.textMuted}>lines={m.lineCount} pid={m.pid ?? "?"} age={age(m.createdAt)}</text>
                  <Show when={m.lastLine}>
                    <text fg={theme.textMuted}>└ {m.lastLine}</text>
                  </Show>
                </box>
              )}
            </For>

            <Show when={other > 0}>
              <text fg={theme.textMuted}>+{other} in other session(s)</text>
            </Show>
          </box>
        )
      },
    },
  } as never)

  return undefined
}

export default { id: "opencode-monitor", tui }
