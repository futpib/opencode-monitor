import test from "node:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

// The fixture drives the actual server tools and rendered sidebar on either
// major version. Only model responses are simulated; no credentials are used.
test("real OpenCode tools, delivery, sidebar and cleanup on v1 or v2", {
  skip: !process.env.OPENCODE_TEST_BINARY,
}, async (t) => {
  const { stdout } = await promisify(execFile)("python3", ["-u", fileURLToPath(new URL("live.py", import.meta.url))], {
    timeout: 240000,
    maxBuffer: 1024 * 1024,
  })
  t.diagnostic(stdout.trim())
})
