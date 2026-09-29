import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/server.ts"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("V2 plugin registers executable tools, forwards wakes and cleans up on unload", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-monitor-v2-"))
  const tools = new Map<string, { execute(input: unknown, context?: unknown): Promise<{ content: string }> }>()
  const prompts: { sessionID: string; text: string; delivery: "queue" }[] = []
  const ctx = {
    location: { directory },
    session: { prompt: async (input: { sessionID: string; text: string; delivery: "queue" }) => { prompts.push(input) } },
    tool: { transform: async (register: (editor: { add(tool: { name: string; execute: (input: unknown, context?: unknown) => Promise<{ content: string }> }): void }) => void) => {
      register({ add: (tool) => tools.set(tool.name, tool) })
    } },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) {
      while (!signal.aborted) await sleep(10)
    } },
  }
  let cleanup: (() => void) | undefined
  try {
    assert.equal(plugin.id, "opencode-monitor")
    cleanup = await plugin.setup(ctx as never) as () => void
    assert.deepEqual([...tools.keys()], ["monitor", "monitor_list", "monitor_stop"])
    const armed = await tools.get("monitor")!.execute({ command: "echo ready", persistent: true }, { sessionID: "ses_test" })
    assert.match(armed.content, /<monitor_armed id="m_[a-f0-9]+">/)
    for (let i = 0; i < 100 && prompts.length < 2; i++) await sleep(10)
    assert.deepEqual(prompts.map((p) => p.sessionID), ["ses_test", "ses_test"])
    assert.ok(prompts.every((p) => p.delivery === "queue"))
    assert.match(prompts[0]!.text, /ready/)
    assert.match(prompts[1]!.text, /command finished/)
    assert.equal((await tools.get("monitor_list")!.execute({})).content, "(no active monitors)")
    const watching = await tools.get("monitor")!.execute({ command: "sleep 30", persistent: true }, { sessionID: "ses_test" })
    const id = watching.content.match(/id="(m_[a-f0-9]+)"/)![1]!
    assert.match((await tools.get("monitor_stop")!.execute({ id })).content, /stopped/)
    const second = await tools.get("monitor")!.execute({ command: "sleep 30", persistent: true }, { sessionID: "ses_test" })
    assert.match(second.content, /<monitor_armed/)
    cleanup()
    cleanup = undefined
    assert.equal((await tools.get("monitor_list")!.execute({})).content, "(no active monitors)")
  } finally {
    cleanup?.()
    rmSync(directory, { recursive: true, force: true })
  }
})
