import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("published TUI entry parses as JavaScript without a runtime JSX transform", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  const entry = new URL("../" + pkg.exports["./tui"].default, import.meta.url)
  assert.ok(existsSync(entry), "build must produce the exported TUI entry")
  execFileSync(process.execPath, ["--check", fileURLToPath(entry)])
  assert.ok(!existsSync(new URL("../dist/tui.jsx", import.meta.url)), "do not ship uncompiled JSX")
})
