"""Real v1/v2 server, tools and TUI; only the model is a controlled local fixture."""
import base64
import http.server
import json
import os
from pathlib import Path
import queue
import re
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.request


def wait(check, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value:
            return value
        time.sleep(0.05)
    raise AssertionError(f"Timed out waiting for {label}")


def terminate(*_):
    raise SystemExit(1)


def main():
    signal.signal(signal.SIGTERM, terminate)
    binary = os.environ["OPENCODE_TEST_BINARY"]
    version = subprocess.check_output([binary, "--version"], text=True).strip()
    v2 = any(word.lstrip("v").startswith("2.") for word in version.split())
    plugin = Path(os.environ.get("OPENCODE_TEST_PLUGIN", Path(__file__).resolve().parents[1])).resolve()
    if plugin.is_file():
        plugin = plugin.parent.parent
    print(f"Testing {version}: {plugin}", flush=True)
    with tempfile.TemporaryDirectory(prefix="opencode-monitor-live-") as tmp:
        root = Path(tmp)
        actions = queue.Queue()
        streams, calls, errors = [], [], []
        stopping = threading.Event()

        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()

                def chunk(delta, reason=None):
                    data = {"id": "chatcmpl-monitor-test", "object": "chat.completion.chunk",
                            "created": 1, "model": "test", "choices": [{"index": 0, "delta": delta,
                                                                         "finish_reason": reason}]}
                    self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
                    self.wfile.flush()

                try:
                    if not body.get("tools"):
                        chunk({"role": "assistant", "content": "Monitor test"}, "stop")
                    elif not actions.empty():
                        name, args = actions.get_nowait()
                        calls.append(body)
                        names = [tool["function"]["name"] for tool in body["tools"]]
                        assert all(n in names for n in ["monitor", "monitor_list", "monitor_stop"]), names
                        chunk({"role": "assistant", "tool_calls": [{"index": 0, "id": f"call_{len(calls)}",
                               "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]})
                        chunk({}, "tool_calls")
                    else:
                        release = threading.Event()
                        chunk({"role": "assistant", "content": "MONITOR_MODEL_WORKING "})
                        streams.append((body, release))
                        while not release.wait(0.05) and not stopping.is_set():
                            pass
                        chunk({"content": "MONITOR_MODEL_DONE"}, "stop")
                    self.wfile.write(b"data: [DONE]\n\n")
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception as error:
                    errors.append(repr(error))

        provider = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        threading.Thread(target=provider.serve_forever, daemon=True).start()
        env = {k: v for k, v in os.environ.items() if not k.startswith(("OPENCODE_", "TMUX", "SLOPD_"))}
        for key, name in [("XDG_CONFIG_HOME", "config"), ("XDG_DATA_HOME", "data"),
                          ("XDG_CACHE_HOME", "cache"), ("XDG_STATE_HOME", "state"), ("XDG_RUNTIME_DIR", "runtime")]:
            (root / name).mkdir(mode=0o700)
            env[key] = str(root / name)
        config_dir = root / "config/opencode"
        config_dir.mkdir()
        config_path = root / "opencode.json"
        env.update({"OPENCODE_CONFIG": str(config_path), "OPENCODE_CONFIG_DIR": str(config_dir),
                    "OPENCODE_TEST_HOME": tmp, "OPENCODE_TEST_MANAGED_CONFIG_DIR": str(root / "managed"),
                    "OPENCODE_DISABLE_PROJECT_CONFIG": "true", "OPENCODE_DISABLE_DEFAULT_PLUGINS": "true",
                    "OPENCODE_DISABLE_MODELS_FETCH": "true", "OPENCODE_DISABLE_CLAUDE_CODE": "true",
                    "OPENCODE_SERVER_PASSWORD": "", "OPENCODE_PASSWORD": "monitor-local-fixture"})
        config_path.write_text(json.dumps({
            "autoupdate": False, "plugin": [str(plugin)], "permission": "allow",
            "enabled_providers": ["monitor-test"], "model": "monitor-test/test", "small_model": "monitor-test/test",
            "provider": {"monitor-test": {"npm": "@ai-sdk/openai-compatible", "name": "Monitor test",
                "options": {"baseURL": f"http://127.0.0.1:{provider.server_port}/v1", "apiKey": "local-test"},
                "models": {"test": {"name": "Test", "limit": {"context": 32768, "output": 1024}}}}}}))
        (config_dir / "cli.json").write_text(json.dumps({"plugins": [str(plugin)], "session": {"sidebar": "auto"}}))
        (config_dir / "tui.json").write_text(json.dumps({"plugin": [str(plugin)]}))
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        url = f"http://127.0.0.1:{port}"
        tmux_socket = str(root / "tmux.sock")
        log = (root / "server.log").open("w+")
        server = subprocess.Popen([binary, "serve", "--hostname", "127.0.0.1", "--port", str(port)],
                                  env=env, cwd=tmp, stdout=log, stderr=log, start_new_session=True)

        def api(path, body=None, method=None, timeout=10):
            headers = {"Content-Type": "application/json", "x-opencode-directory": tmp}
            if v2:
                headers["Authorization"] = "Basic " + base64.b64encode(b"opencode:monitor-local-fixture").decode()
            request = urllib.request.Request(url + ("/api" if v2 else "") + path, headers=headers,
                data=json.dumps(body).encode() if body is not None else None, method=method)
            with urllib.request.urlopen(request, timeout=timeout) as response:
                raw = response.read()
                result = json.loads(raw) if raw else None
                return result.get("data", result) if v2 and isinstance(result, dict) else result

        def tmux(*args, check=True):
            result = subprocess.run(["tmux", "-S", tmux_socket, *args], env=env, cwd=tmp,
                                    capture_output=True, text=True, timeout=10)
            if check:
                assert result.returncode == 0, result.stderr
            return result.stdout

        def prompt(sid, text):
            def send():
                try:
                    if v2:
                        api(f"/session/{sid}/prompt", {"text": text}, timeout=120)
                    else:
                        api(f"/session/{sid}/message", {"parts": [{"type": "text", "text": text}]}, timeout=120)
                except Exception as error:
                    if not stopping.is_set():
                        errors.append(repr(error))
            threading.Thread(target=send, daemon=True).start()

        def idle(sid):
            status = api("/session/active" if v2 else "/session/status")
            return status.get(sid, {}).get("type", "idle") == "idle"

        def admitted(sid):
            messages = api(f"/session/{sid}/message?order=asc")
            if v2:
                messages += api(f"/session/{sid}/inbox")
            return json.dumps(messages)

        def monitors():
            result = []
            for path in (root / "runtime/opencode-monitor").glob("*.sock"):
                with socket.socket(socket.AF_UNIX) as sock:
                    sock.settimeout(2)
                    try:
                        sock.connect(str(path))
                        with sock.makefile() as stream:
                            result += json.loads(stream.readline())["monitors"]
                    except (ConnectionRefusedError, FileNotFoundError):
                        pass
            return result

        def alive(pid):
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False

        def next_stream(n):
            wait(lambda: len(streams) > n or errors, f"model stream {n}")
            assert not errors, errors
            return streams[n]

        def invoke(sid, name, args):
            n = len(streams)
            actions.put((name, args))
            prompt(sid, f"Run {name} for the integration test.")
            body, release = next_stream(n)
            result = json.dumps(body["messages"])
            release.set()
            wait(lambda: idle(sid), f"{name} completion")
            return result

        try:
            def ready():
                assert server.poll() is None, (root / "server.log").read_text()
                try:
                    api("/session" if v2 else "/global/health")
                    return True
                except Exception:
                    return False
            wait(ready, "server startup", 60)
            for index, steer in enumerate([True, False]):
                session = api("/session", {"title": f"Monitor live {steer}", **({"location": {"directory": tmp}} if v2 else {})})
                sid = session["id"]
                event_file = root / f"events-{steer}"
                event_file.touch()
                n = len(streams)
                actions.put(("monitor", {"description": "Live monitor", "command": f"tail -n +1 -s 0.1 -f {shlex.quote(str(event_file))}",
                             "persistent": True, "ready_pattern": "^MONITOR_", **({} if steer else {"steer": False})}))
                prompt(sid, "Arm the integration watcher.")
                first, release = next_stream(n)
                mon = wait(lambda: next((m for m in monitors() if m["parentSessionId"] == sid), None), "armed registry")
                assert mon["cwd"] == tmp and mon["steer"] == steer, mon
                command = [binary, "--server", url, "--session", sid] if v2 else [binary, "attach", url, "--session", sid, "--dir", tmp]
                if index == 0:
                    pane = tmux("-f", "/dev/null", "new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "monitor-test", "-x", "180", "-y", "60", *command).strip()
                else:
                    pane = tmux("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "monitor-test", *command).strip()
                capture = lambda: tmux("capture-pane", "-p", "-t", pane)
                wait(lambda: re.search(r"Monitors\s+\(1\)", capture()), "live sidebar count", 60)
                assert "Live monitor" in capture(), capture()
                with event_file.open("a") as stream:
                    stream.write("IGNORED_LINE\nMONITOR_FIRST\nMONITOR_SECOND\n")
                wait(lambda: "MONITOR_FIRST" in admitted(sid), "first event admission")
                if steer:
                    wait(lambda: "MONITOR_SECOND" in admitted(sid), "second mid-stream event")
                else:
                    time.sleep(0.3)
                    assert "MONITOR_SECOND" not in admitted(sid), "serialized delivery admitted second event early"
                assert "IGNORED_LINE" not in admitted(sid), "regex filter failed"
                assert len(streams) == n + 1, "monitor interrupted the active model stream"
                release.set()
                second, release = next_stream(n + 1)
                text = json.dumps(second["messages"])
                assert "MONITOR_FIRST" in text and ("MONITOR_SECOND" in text) == steer, text
                if steer:
                    assert text.index("MONITOR_FIRST") < text.index("MONITOR_SECOND"), text
                release.set()
                if not steer:
                    third, release = next_stream(n + 2)
                    assert "MONITOR_SECOND" in json.dumps(third["messages"])
                    release.set()
                wait(lambda: idle(sid), "completed event responses")
                n = len(streams)
                with event_file.open("a") as stream:
                    stream.write("MONITOR_IDLE\n")
                body, release = next_stream(n)
                assert "MONITOR_IDLE" in json.dumps(body["messages"])
                release.set()
                wait(lambda: idle(sid), "idle wake response")
                wait(lambda: "MONITOR_IDLE" in capture(), "sidebar line update")
                assert mon["id"] in invoke(sid, "monitor_list", {})
                assert f"stopped {mon['id']}" in invoke(sid, "monitor_stop", {"id": mon["id"]})
                wait(lambda: not monitors() and not alive(mon["pid"]), "stopped watcher reaped")
                wait(lambda: re.search(r"Monitors\s+\(0\)", capture()), "empty sidebar")
                invoke(sid, "monitor", {"description": "Deletion cleanup", "command": "sleep 120", "persistent": True})
                child = wait(lambda: next(iter(monitors()), None), "cleanup watcher")
                api(f"/session/{sid}", method="DELETE")
                wait(lambda: not monitors() and not alive(child["pid"]), "session deletion reaped watcher")
                if index == 1:
                    tmux("kill-pane", "-t", pane)
                print(f"PASS steer={steer}: tools, regex, mid-stream delivery, boundary, idle wake, sidebar, stop, session cleanup", flush=True)
            if v2:
                sid = api("/session", {"title": "Plugin disposal", "location": {"directory": tmp}})["id"]
                invoke(sid, "monitor", {"description": "Disposal cleanup", "command": "sleep 120", "persistent": True})
                child = wait(lambda: next(iter(monitors()), None), "disposal watcher")
                config = json.loads(config_path.read_text())
                config["plugin"] = []
                config_path.write_text(json.dumps(config))
                wait(lambda: not monitors() and not alive(child["pid"]), "plugin disposal reaped watcher")
                assert not list((root / "runtime/opencode-monitor").glob("*.sock")), "disposal leaked status socket"
                api(f"/session/{sid}", method="DELETE")
                print("PASS v2 plugin disposal: watcher and status socket removed", flush=True)
            assert not errors, errors
        except Exception:
            print("\n".join(line for line in (root / "server.log").read_text().splitlines() if "password" not in line)[-18000:], flush=True)
            print(tmux("capture-pane", "-p", check=False), flush=True)
            raise
        finally:
            stopping.set()
            for _, release in streams:
                release.set()
            tmux("kill-server", check=False)
            if server.poll() is None:
                os.killpg(server.pid, 15)
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(server.pid, 9)
                    server.wait(timeout=5)
            provider.shutdown()
            provider.server_close()
            log.close()


if __name__ == "__main__":
    main()
