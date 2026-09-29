import { execFileSync } from "node:child_process"
import { unlinkSync, writeFileSync } from "node:fs"
import { transformFileAsync } from "@babel/core"
import solid from "babel-preset-solid"

execFileSync("tsc", ["-p", "tsconfig.tui.json"], { stdio: "inherit" })

// OpenTUI skips the runtime JSX transform for packages under node_modules.
// Ship plain JS, keeping the renderer imports external for the host to share.
const result = await transformFileAsync("dist/tui.jsx", {
  configFile: false,
  babelrc: false,
  presets: [[solid, { moduleName: "@opentui/solid", generate: "universal" }]],
})
if (!result?.code) throw new Error("Solid compilation produced no TUI code")
writeFileSync("dist/tui.js", result.code + "\n")
unlinkSync("dist/tui.jsx")
