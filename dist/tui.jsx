/** @jsxImportSource @opentui/solid */
import { createSignal, For, Show } from "solid-js";
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { join } from "node:path";
// MUST stay byte-identical to the twin in src/server.ts — both sides derive the
// same socket path from the worktree so the TUI connects to its own server.
function statusSocketPath(worktree) {
    const dir = process.env.XDG_RUNTIME_DIR || "/tmp";
    const h = createHash("sha256").update(worktree || "").digest("hex").slice(0, 16);
    return join(dir, "opencode-monitor", `status-${h}.sock`);
}
function age(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60}m`;
}
export const tui = async (api) => {
    const [mons, setMons] = createSignal([]);
    // Hold one connection to the backend's status socket; the server pushes a
    // snapshot on every change. Reconnect on drop (server restart, etc.).
    let stopped = false;
    let live = null;
    let buf = "";
    const ingest = (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            try {
                const parsed = JSON.parse(line);
                if (Array.isArray(parsed?.monitors))
                    setMons(parsed.monitors);
            }
            catch {
                /* partial / non-json line */
            }
        }
    };
    const connect = () => {
        if (stopped)
            return;
        let armed = false;
        const path = statusSocketPath(api.state.path.directory);
        const sock = createConnection(path);
        const reopen = () => {
            if (armed || stopped)
                return;
            armed = true;
            setMons([]);
            setTimeout(connect, 1000);
        };
        sock.on("data", ingest);
        sock.on("error", () => {
            reopen();
            try {
                sock.destroy();
            }
            catch {
                /* ignore */
            }
        });
        sock.on("close", reopen);
        live = sock;
    };
    connect();
    api.lifecycle.onDispose(() => {
        stopped = true;
        live?.destroy();
    });
    api.slots.register({
        order: 250,
        slots: {
            sidebar_content(_ctx, props) {
                const theme = api.theme.current;
                const list = mons();
                const here = list.filter((m) => m.parentSessionId === props.session_id);
                const other = list.length - here.length;
                const colorFor = (s) => s === "running"
                    ? theme.success
                    : s === "exited"
                        ? theme.textMuted
                        : theme.warning;
                return (<box flexDirection="column" gap={0}>
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>Monitors</text>
              <text fg={theme.textMuted}>({list.length})</text>
            </box>

            <Show when={list.length === 0}>
              <text fg={theme.textMuted}>no active monitors</text>
            </Show>

            <For each={list}>
              {(m) => (<box flexDirection="column" gap={0}>
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
                </box>)}
            </For>

            <Show when={other > 0}>
              <text fg={theme.textMuted}>+{other} in other session(s)</text>
            </Show>
          </box>);
            },
        },
    });
    return undefined;
};
export default { id: "opencode-monitor", tui };
