/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createSignal, createMemo, For, Show, onCleanup } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

interface MonInfo {
  id: string
  command: string
  parentSessionId: string
  status: string
  pid: number | null
  lineCount: number
  lastLine: string | null
}

const STATE_PATH =
  (process.env.XDG_DATA_HOME || `${homedir()}/.local/share`) + "/opencode-monitor/state.json"

function readState(): MonInfo[] {
  try {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as { monitors?: MonInfo[] }
    return parsed.monitors ?? []
  } catch {
    return []
  }
}

function statusColor(status: string, theme: any): string {
  if (status === "running") return theme.success
  if (status === "exited") return theme.textMuted
  if (status === "killed") return theme.warning
  if (status === "error") return theme.error
  return theme.textMuted
}

function shortCmd(cmd: string): string {
  const trimmed = cmd.replace(/\s+/g, " ").trim()
  return trimmed.length > 34 ? trimmed.slice(0, 33) + "…" : trimmed
}

function View(props: { api: any; sessionID: string }) {
  const [tick, setTick] = createSignal(0)
  const timer = setInterval(() => setTick((t) => t + 1), 1000)
  onCleanup(() => clearInterval(timer))

  const theme = () => props.api.theme.current
  const mine = createMemo<MonInfo[]>(() => {
    void tick()
    return readState().filter((m) => m.parentSessionId === props.sessionID)
  })
  const running = createMemo(() => mine().filter((m) => m.status === "running").length)

  return (
    <Show when={mine().length > 0}>
      <box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>
            <b>Monitors</b>
            <span style={{ fg: theme().textMuted }}>
              {" "}({running()} active, {mine().length})
            </span>
          </text>
        </box>
        <For each={mine()}>
          {(m) => (
            <box flexDirection="row" gap={1}>
              <text flexShrink={0} style={{ fg: statusColor(m.status, theme()) }}>
                •
              </text>
              <text fg={theme().text} wrapMode="word">
                {m.id}{" "}
                <span style={{ fg: theme().textMuted }}>
                  {m.status} · {m.lineCount}L · {shortCmd(m.command)}
                </span>
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export const tui: TuiPlugin = async (api) => {
  api.slots.register({
    id: "opencode-monitor:sidebar",
    order: 250,
    slots: {
      sidebar_content(props: any) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  } as any)
}

export default { id: "opencode-monitor", tui }
