/** @jsxImportSource @opentui/solid */
import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, For, Show } from "solid-js"

interface Mon {
  id: string
  command: string
  status: string
  lines: number
}

const RE_ARMED = /<monitor_armed id="(m_[0-9a-f]+)">[\s\S]*?command:\s*([^\n]*)/
const RE_LINE = /<monitor id="(m_[0-9a-f]+)" line="(\d+)">/
const RE_EXITED = /<monitor id="(m_[0-9a-f]+)" exited code="(\d+)">/
const RE_STOPPED = /\bstopped (m_[0-9a-f]+)\b/

function parseMonitors(text: string): Mon[] {
  const armed = new Map<string, Mon>()
  let m: RegExpExecArray | null
  const armRe = new RegExp(RE_ARMED.source, "g")
  while ((m = armRe.exec(text))) armed.set(m[1], { id: m[1], command: m[2].trim(), status: "running", lines: 0 })
  const lineRe = new RegExp(RE_LINE.source, "g")
  while ((m = lineRe.exec(text))) {
    const e = armed.get(m[1])
    if (e) {
      e.lines = Math.max(e.lines, Number(m[2]))
      e.status = "running"
    }
  }
  const exitRe = new RegExp(RE_EXITED.source, "g")
  while ((m = exitRe.exec(text))) {
    const e = armed.get(m[1])
    if (e) e.status = "exited"
  }
  const stopRe = new RegExp(RE_STOPPED.source, "g")
  while ((m = stopRe.exec(text))) armed.delete(m[1])
  return [...armed.values()]
}

function monitorText(api: any, sessionID: string): string {
  const msgs = (api.state.session.messages(sessionID) ?? []) as ReadonlyArray<any>
  let out = ""
  for (const msg of msgs.slice(-120)) {
    const id = msg.info?.id ?? msg.id
    if (!id) continue
    const parts = (api.state.part(id) ?? msg.parts ?? []) as ReadonlyArray<any>
    for (const p of parts) {
      const t = typeof p === "string" ? p : p.text ?? p.result
      if (typeof t === "string" && t.includes("<monitor")) out += "\n" + t
    }
  }
  return out
}

function statusColor(status: string, theme: any): string {
  if (status === "running") return theme.success
  if (status === "exited") return theme.textMuted
  return theme.textMuted
}

function shortCmd(cmd: string): string {
  const t = cmd.replace(/\s+/g, " ").trim()
  return t.length > 34 ? t.slice(0, 33) + "…" : t
}

function View(props: { api: any; sessionID: string }) {
  const theme = () => props.api.theme.current
  const mine = createMemo<Mon[]>(() => parseMonitors(monitorText(props.api, props.sessionID)))
  const running = createMemo(() => mine().filter((x) => x.status === "running").length)

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
                  {m.status} · {m.lines}L · {shortCmd(m.command)}
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
