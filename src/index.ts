import { tool } from "@opencode-ai/plugin"
import type { Plugin } from "@opencode-ai/plugin"
import { runMonitor, formatResult } from "./monitor.ts"

const DESCRIPTION = `Block on an external condition without spending agent turns. Runs a shell command that waits until the condition becomes true, then returns control to the agent. Use this INSTEAD of polling in a loop or sleep.

The agent is parked (near-zero cost) while the command runs and resumes when it exits, when a stdout line matches ready_pattern, or when timeout_seconds elapses. Captured stdout/stderr is returned.

Patterns:
- wait for a port:  while ! curl -sf localhost:3000/health; do sleep 1; done
- wait for a file:  while [ ! -f build/done ]; do sleep 1; done
- wait for a log line:  tail -n0 -f app.log   (with ready_pattern)
- wait for CI/build done:  gh run watch <id>  or your build command with ready_pattern="DONE|FAIL"`

export const MonitorPlugin: Plugin = async () => ({
  tool: {
    monitor: tool({
      description: DESCRIPTION,
      args: {
        command: tool.schema
          .string()
          .describe("Shell command that blocks until the condition is met, then exits (or prints a ready_pattern line)."),
        ready_pattern: tool.schema
          .string()
          .optional()
          .describe("Regex. Return as soon as a stdout line matches, without waiting for the command to exit."),
        timeout_seconds: tool.schema
          .number()
          .optional()
          .describe("Max seconds to wait. Default 600, capped at 3600."),
        cwd: tool.schema
          .string()
          .optional()
          .describe("Working directory. Defaults to the project directory."),
      },
      async execute(args: any, context: any) {
        const requested = Math.floor(Number(args?.timeout_seconds ?? 600)) || 600
        const timeoutSeconds = Math.min(Math.max(requested, 1), 3600)
        const result = await runMonitor({
          command: String(args.command),
          cwd: args.cwd ?? context?.directory,
          readyPattern: args.ready_pattern,
          timeoutMs: timeoutSeconds * 1000,
        })
        return formatResult(result)
      },
    }),
  },
})

export { runMonitor, formatResult } from "./monitor.ts"
export type { MonitorOptions, MonitorResult, MonitorOutcome } from "./monitor.ts"
