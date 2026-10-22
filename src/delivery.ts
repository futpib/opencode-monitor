import type { SessionDomain } from "@opencode/plugin/promise/session"
import type { MonitorDelivery } from "./manager.ts"

export interface MonitorClient {
  session: {
    prompt: (opts: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string }> }
      signal?: AbortSignal
    }) => Promise<unknown>
  }
}

export function v1Delivery(client: MonitorClient): MonitorDelivery {
  return async ({ sessionID, text, steer, signal }) => {
    // The synchronous route admits input mid-run and reliably wakes idle v1
    // sessions. Only serialized delivery waits for its complete response.
    const response = client.session.prompt({
      path: { id: sessionID }, body: { parts: [{ type: "text", text }] }, signal,
    }).catch(() => { /* session closed or monitor stopped */ })
    if (!steer) await response
  }
}

export function v2Delivery(session: Pick<SessionDomain, "synthetic" | "wait">): MonitorDelivery {
  return async ({ sessionID, text, steer, signal }) => {
    // Await admission to preserve line order. resume also wakes an idle session;
    // synthetic notifications do not impersonate a new user prompt.
    await session.synthetic({ sessionID, text, delivery: "steer", resume: true }, { signal })
    if (!steer) await session.wait({ sessionID }, { signal })
  }
}
