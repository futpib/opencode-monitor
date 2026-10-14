import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { createServer as createPortServer } from "node:net"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import { registerHooks, stripTypeScriptTypes } from "node:module"
import { createOpencodeClient } from "@opencode-ai/sdk"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail(`Timed out waiting for ${label}`)
}

test("real OpenCode receives steering during streaming, preserves opt-out, and wakes idle sessions", {
  skip: !process.env.OPENCODE_TEST_BINARY,
  timeout: 90000,
}, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-monitor-steering-"))
  const pluginEntry = new URL(process.env.OPENCODE_TEST_PLUGIN ?? "../src/server.ts", import.meta.url)
  const cleanup: Array<() => void | Promise<void>> = [() => rmSync(tmp, { recursive: true, force: true })]
  t.after(async () => { for (const stop of cleanup.toReversed()) await stop() })
  const requests: Array<{ body: { messages: unknown[]; tools?: Array<{ function: { name: string; parameters: any } }> }; finish: () => void }> = []
  const provider = createServer(async (req, res) => {
    let raw = ""
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    const chunk = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({
      id: "chatcmpl-steering-test", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`)
    chunk({ role: "assistant", content: "Working. " }, null)
    requests.push({ body, finish: () => {
      if (res.writableEnded || res.destroyed) return
      chunk({ content: "Done." }, "stop")
      res.end("data: [DONE]\n\n")
    } })
  })
  provider.listen(0, "127.0.0.1")
  await once(provider, "listening")
  cleanup.push(() => { provider.closeAllConnections(); provider.close() })
  const providerPort = (provider.address() as { port: number }).port

  const portServer = createPortServer().listen(0, "127.0.0.1")
  await once(portServer, "listening")
  const port = (portServer.address() as { port: number }).port
  await new Promise<void>((resolve) => portServer.close(() => resolve()))
  const configPath = join(tmp, "opencode.json")
  writeFileSync(configPath, JSON.stringify({
    autoupdate: false,
    plugin: [fileURLToPath(pluginEntry)],
    enabled_providers: ["monitor-test"],
    model: "monitor-test/test",
    provider: { "monitor-test": {
      npm: "@ai-sdk/openai-compatible", name: "Monitor test",
      options: { baseURL: `http://127.0.0.1:${providerPort}/v1`, apiKey: "local-test" },
      models: { test: { name: "Test", limit: { context: 32768, output: 1024 } } },
    } },
  }))
  mkdirSync(join(tmp, "runtime"), { mode: 0o700 })
  const server = spawn(process.env.OPENCODE_TEST_BINARY!, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: tmp,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(tmp, "config"), XDG_DATA_HOME: join(tmp, "data"),
      XDG_CACHE_HOME: join(tmp, "cache"), XDG_STATE_HOME: join(tmp, "state"),
      XDG_RUNTIME_DIR: join(tmp, "runtime"),
      OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: join(tmp, "config/opencode"),
      OPENCODE_SERVER_PASSWORD: "", OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let logs = ""
  server.stdout!.on("data", (chunk) => { logs += chunk })
  server.stderr!.on("data", (chunk) => { logs += chunk })
  const exited = once(server, "exit")
  cleanup.push(async () => {
    for (const req of requests) req.finish()
    if (server.exitCode === null && server.signalCode === null) {
      process.kill(-server.pid!, "SIGTERM")
      await Promise.race([exited, sleep(2000)])
      if (server.exitCode === null && server.signalCode === null) process.kill(-server.pid!, "SIGKILL")
      await exited
    }
  })
  const baseUrl = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    assert.equal(server.exitCode, null, logs)
    try {
      const response = await fetch(`${baseUrl}/global/health`, { signal: AbortSignal.timeout(2000) })
      await response.text()
      return response.ok
    } catch { return false }
  }, "OpenCode startup")
  t.diagnostic("Isolated OpenCode server started")
  const client = createOpencodeClient({ baseUrl, directory: tmp })
  // Node refuses automatic type stripping inside node_modules; OpenCode's Bun
  // runtime supports it. Strip only the installed manager and its shell engine
  // so this test exercises their original files without copying or rebuilding.
  const moduleUrls = new Set(["manager.ts", "monitor.ts"].map((file) => new URL(file, pluginEntry).href))
  const hooks = registerHooks({ load(url, context, nextLoad) {
    if (!moduleUrls.has(url)) return nextLoad(url, context)
    return { format: "module", shortCircuit: true,
      source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) }
  } })
  cleanup.push(() => hooks.deregister())
  const { createMonitorManager } = await import(new URL("./manager.ts", pluginEntry).href) as typeof import("../src/manager.ts")
  const mgr = createMonitorManager(client)
  const sessions: string[] = []
  cleanup.push(async () => {
    for (const mon of mgr.list()) mgr.stop(mon.id)
    for (const id of sessions) {
      await client.session.abort({ path: { id } })
      await client.session.delete({ path: { id } })
    }
  })
  const userText = async (id: string) => {
    const result = await client.session.messages({ path: { id }, signal: AbortSignal.timeout(3000) })
    assert.equal(result.error, undefined)
    return result.data!.filter((m) => m.info.role === "user")
      .flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text)).join("\n")
  }
  const isIdle = async (id: string) => {
    const result = await client.session.status({ signal: AbortSignal.timeout(3000) })
    assert.equal(result.error, undefined)
    const status = result.data?.[id]?.type
    return status === undefined || status === "idle"
  }
  const eventAbort = new AbortController()
  const events = await client.event.subscribe({ signal: eventAbort.signal })
  const eventTexts: string[] = []
  const readEvents = (async () => {
    for await (const event of events.stream) eventTexts.push(JSON.stringify(event))
  })().catch(() => { /* subscription closes during cleanup */ })
  cleanup.push(() => { eventAbort.abort(); void readEvents })

  for (const steer of [true, false]) {
    const result = await client.session.create({ body: { title: `Monitor steering ${steer}` }, signal: AbortSignal.timeout(15000) })
    assert.equal(result.error, undefined, logs)
    t.diagnostic(`Created session for steer=${steer}`)
    const id = result.data!.id
    sessions.push(id)
    const start = requests.length
    const running = client.session.prompt({ path: { id }, body: {
      model: { providerID: "monitor-test", modelID: "test" },
      parts: [{ type: "text", text: "Begin the streaming test." }],
    } })
    await waitFor(() => requests.length > start, "first provider stream")
    await waitFor(() => eventTexts.some((event) => event.includes(id) && event.includes("Working.")), "streamed assistant text")
    t.diagnostic(`Provider streaming for steer=${steer}`)
    const definition = requests[start]!.body.tools!.find((tool) => tool.function.name === "monitor")
    assert.equal(definition?.function.parameters.properties.steer.type, "boolean", "loaded monitor tool lacks the opt-out")

    const mon = mgr.arm({ command: "echo MONITOR_FIRST; echo MONITOR_SECOND; sleep 30", parentSessionId: id,
      ...(steer ? {} : { steer: false }) })
    await waitFor(async () => (await userText(id)).includes("MONITOR_FIRST"), "first event admission")
    if (steer) {
      await waitFor(async () => (await userText(id)).includes("MONITOR_SECOND"), "second event during streaming")
    } else {
      await sleep(150)
      assert.ok(!(await userText(id)).includes("MONITOR_SECOND"), "opt-out admitted a second event mid-turn")
    }
    assert.equal(requests.length, start + 1, "event interrupted the active provider stream")
    requests[start]!.finish()
    await waitFor(() => requests.length > start + 1, "next provider turn")
    const next = JSON.stringify(requests[start + 1]!.body.messages)
    assert.ok(next.includes("MONITOR_FIRST"), next)
    assert.equal(next.includes("MONITOR_SECOND"), steer, next)
    if (steer) assert.ok(next.indexOf("MONITOR_FIRST") < next.indexOf("MONITOR_SECOND"), "steering reordered events")
    requests[start + 1]!.finish()
    const response = await running
    assert.equal(response.error, undefined, logs)
    assert.equal(response.data!.info.error, undefined)
    assert.equal(response.data!.info.finish, "stop")
    assert.ok(response.data!.parts.some((p) => p.type === "text" && p.text.includes("Done.")))
    if (!steer) {
      await waitFor(() => requests.length > start + 2, "serialized second event")
      assert.ok(JSON.stringify(requests[start + 2]!.body.messages).includes("MONITOR_SECOND"))
      requests[start + 2]!.finish()
    }
    mgr.stop(mon.id)
    await waitFor(() => isIdle(id), "idle session")

    const idleStart = requests.length
    const idle = mgr.arm({ command: "echo MONITOR_IDLE; sleep 30", parentSessionId: id,
      ...(steer ? {} : { steer: false }) })
    await waitFor(() => requests.length > idleStart, "automatic idle wake")
    assert.ok(JSON.stringify(requests[idleStart]!.body.messages).includes("MONITOR_IDLE"))
    requests[idleStart]!.finish()
    mgr.stop(idle.id)
    await waitFor(() => isIdle(id), "idle wake completion")
    t.diagnostic(`Verified mid-stream delivery, model boundary, and idle wake for steer=${steer}`)
  }
})
