#!/usr/bin/env python3
import argparse
import json
import os
import shlex
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

import paramiko
import urllib3
from kubernetes import client, config
from kubernetes.client.exceptions import ApiException
from kubernetes.config.config_exception import ConfigException


APP_NAME = "LogStation"
MAX_BODY_SIZE = 1024 * 1024
TAIL_LINES = 300
MAX_TAIL_LINES = 10000
sources = {}
sources_lock = threading.RLock()


class ServiceError(Exception):
    def __init__(self, message, status=400, code="request_failed"):
        super().__init__(message)
        self.status = status
        self.code = code


def data_dir():
    return Path(os.environ.get("LOGSTATION_HOME", Path.home() / ".logstation"))


def sources_file():
    return data_dir() / "sources.json"


def public_source(source):
    result = {key: value for key, value in source.items() if key != "password"}
    if source.get("type") == "ssh":
        result["requiresPassword"] = not bool(source.get("password"))
    return result


def save_sources():
    data_dir().mkdir(mode=0o700, parents=True, exist_ok=True)
    with sources_lock:
        stored = [public_source(source) for source in sources.values()]
        path = sources_file()
        temporary = path.with_suffix(".tmp")
        temporary.write_text(json.dumps(stored, indent=2), encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(path)


def load_sources():
    path = sources_file()
    if not path.exists():
        return
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Could not load saved sources from {path}: {exc}") from exc
    if not isinstance(loaded, list):
        raise RuntimeError(f"Saved sources in {path} must be a JSON array")
    for source in loaded:
        if isinstance(source, dict) and source.get("id") and source.get("type"):
            source["password"] = ""
            sources[source["id"]] = source


def kube_api(context_name):
    try:
        configuration = client.Configuration()
        config.load_kube_config(
            config_file=None, context=context_name or None,
            client_configuration=configuration,
        )
        return client.CoreV1Api(client.ApiClient(configuration))
    except (ConfigException, OSError, ValueError, TypeError) as exc:
        raise ServiceError(f"Could not load Kubernetes context: {exc}", 502, "kubernetes_error") from exc


def kube_contexts():
    try:
        contexts, active = config.list_kube_config_contexts()
        return [
            {"name": item["name"], "cluster": item["context"].get("cluster", "")}
            for item in contexts
        ], active["name"] if active else ""
    except (ConfigException, OSError, ValueError, TypeError) as exc:
        raise ServiceError(
            f"Could not read the local kubeconfig: {exc}", 502, "kubernetes_error"
        ) from exc


def validate_source(source):
    source_type = source.get("type")
    if source_type == "kubernetes":
        if not source.get("context") or not source.get("namespace"):
            raise ServiceError("Choose a Kubernetes context and namespace.")
        return
    if source_type in ("local", "ssh"):
        paths = source.get("paths")
        if not isinstance(paths, list) or not paths or any(
            not isinstance(path, str) or not path.strip() for path in paths
        ):
            raise ServiceError("Enter at least one log file path.")
        source["paths"] = [path.strip() for path in paths]
        if source_type == "ssh":
            if not source.get("host") or not source.get("username"):
                raise ServiceError("Enter the SSH host and username.")
            if not source.get("password"):
                raise ServiceError(
                    "Enter the SSH password. Passwords are held in memory only.",
                    428, "password_required",
                )
        return
    raise ServiceError("Choose Kubernetes, SSH, or local files.")


def connect_ssh(source):
    ssh = paramiko.SSHClient()
    known_hosts = Path.home() / ".ssh" / "known_hosts"
    known_hosts.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    known_hosts.touch(mode=0o600, exist_ok=True)
    ssh.load_system_host_keys()
    ssh.load_host_keys(str(known_hosts))
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        ssh.connect(
            hostname=source["host"],
            username=source["username"],
            password=source.get("password") or None,
            timeout=8,
            banner_timeout=8,
            auth_timeout=8,
            look_for_keys=not bool(source.get("password")),
            allow_agent=not bool(source.get("password")),
        )
        return ssh
    except (paramiko.SSHException, OSError, TimeoutError, EOFError, ValueError):
        ssh.close()
        raise


def test_source(source):
    validate_source(source)
    if source["type"] == "kubernetes":
        try:
            kube_api(source["context"]).list_namespaced_pod(source["namespace"], limit=1)
        except ServiceError:
            raise
        except (ApiException, urllib3.exceptions.HTTPError, OSError) as exc:
            raise ServiceError(
                f"Kubernetes connection failed: {getattr(exc, 'reason', None) or exc}",
                502, "kubernetes_error",
            ) from exc
    elif source["type"] == "local":
        for path in source["paths"]:
            try:
                with open(path, "rb") as log_file:
                    log_file.read(1)
            except OSError as exc:
                raise ServiceError(f"Cannot read {path}: {exc}", 400, "file_error") from exc
    else:
        try:
            with connect_ssh(source) as ssh:
                for path in source["paths"]:
                    _, stdout, stderr = ssh.exec_command(
                        f"test -r {shlex.quote(path)}", timeout=8
                    )
                    exit_code = stdout.channel.recv_exit_status()
                    if exit_code:
                        reason = stderr.read().decode("utf-8", "replace").strip()
                        raise ServiceError(
                            f"Cannot read {path} over SSH{': ' + reason if reason else ''}",
                            400, "file_error",
                        )
        except ServiceError:
            raise
        except (paramiko.SSHException, OSError, TimeoutError, EOFError, ValueError, KeyError) as exc:
            raise ServiceError(f"SSH connection failed: {exc}", 502, "ssh_error") from exc
    return {"ok": True, "message": "Connection successful."}


def list_files(source):
    if source["type"] in ("local", "ssh"):
        return [
            {"id": path, "label": Path(path).name or path, "detail": path}
            for path in source["paths"]
        ]
    try:
        pods = kube_api(source["context"]).list_namespaced_pod(
            source["namespace"], limit=500
        ).items
    except ServiceError:
        raise
    except (ApiException, urllib3.exceptions.HTTPError, OSError) as exc:
        raise ServiceError(
            f"Could not list Kubernetes pods: {getattr(exc, 'reason', None) or exc}",
            502, "kubernetes_error",
        ) from exc
    result = []
    for pod in pods:
        for container in pod.spec.containers:
            item_id = json.dumps([pod.metadata.name, container.name], separators=(",", ":"))
            result.append({
                "id": item_id,
                "label": container.name,
                "detail": pod.metadata.name,
            })
    return result


def read_local_tail(path, tail_lines=TAIL_LINES):
    with open(path, "rb") as log_file:
        log_file.seek(0, os.SEEK_END)
        position = log_file.tell()
        chunks = []
        newlines = 0
        bytes_read = 0
        while position > 0 and newlines <= tail_lines and bytes_read < 2 * 1024 * 1024:
            size = min(8192, position)
            position -= size
            log_file.seek(position)
            chunk = log_file.read(size)
            chunks.append(chunk)
            newlines += chunk.count(b"\n")
            bytes_read += size
        text = b"".join(reversed(chunks)).decode("utf-8", "replace")
        return "\n".join(text.splitlines()[-tail_lines:])


def parse_tail_lines(query):
    value = parse_qs(query, keep_blank_values=True).get("lines", [str(TAIL_LINES)])[0]
    try:
        tail_lines = int(value)
    except ValueError as exc:
        raise ServiceError("Tail line count must be an integer.") from exc
    if not 1 <= tail_lines <= MAX_TAIL_LINES:
        raise ServiceError(f"Tail line count must be between 1 and {MAX_TAIL_LINES}.")
    return tail_lines


def get_logs(source, item_id, tail_lines=TAIL_LINES):
    if source["type"] == "local":
        if item_id not in source["paths"]:
            raise ServiceError("Unknown log file for this source.")
        try:
            return read_local_tail(item_id, tail_lines)
        except OSError as exc:
            raise ServiceError(f"Cannot read {item_id}: {exc}", 400, "file_error") from exc
    if source["type"] == "ssh":
        if item_id not in source["paths"]:
            raise ServiceError("Unknown log file for this source.")
        try:
            with connect_ssh(source) as ssh:
                _, stdout, stderr = ssh.exec_command(
                    f"tail -n {tail_lines} -- {shlex.quote(item_id)}", timeout=10
                )
                output = stdout.read().decode("utf-8", "replace")
                error = stderr.read().decode("utf-8", "replace").strip()
                code = stdout.channel.recv_exit_status()
                if code:
                    raise ServiceError(
                        f"Could not read {item_id} over SSH{': ' + error if error else ''}",
                        502, "file_error",
                    )
                return output.rstrip("\n")
        except ServiceError:
            raise
        except (paramiko.SSHException, OSError, TimeoutError, EOFError, ValueError, KeyError) as exc:
            raise ServiceError(f"SSH log read failed: {exc}", 502, "ssh_error") from exc
    try:
        pod_name, container_name = json.loads(item_id)
        return kube_api(source["context"]).read_namespaced_pod_log(
            name=pod_name,
            namespace=source["namespace"],
            container=container_name,
            tail_lines=tail_lines,
            timestamps=True,
        )
    except ServiceError:
        raise
    except (ApiException, urllib3.exceptions.HTTPError, OSError) as exc:
        raise ServiceError(
            f"Could not read Kubernetes logs: {getattr(exc, 'reason', None) or exc}",
            502, "kubernetes_error",
        ) from exc
    except (ValueError, TypeError) as exc:
        raise ServiceError("Invalid Kubernetes log selection.") from exc


def asset_path(name):
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base / "web" / name


class Handler(BaseHTTPRequestHandler):
    server_version = "LogStation"

    def log_message(self, fmt, *args):
        # Keep request data, including source IDs and query values, out of logs.
        sys.stderr.write(f"{self.address_string()} - {fmt % args}\n")

    def _send_json(self, data, status=200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, error):
        self._send_json({"error": str(error), "code": getattr(error, "code", "request_failed")},
                        getattr(error, "status", 500))

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ServiceError("Invalid Content-Length.") from exc
        if length < 0 or length > MAX_BODY_SIZE:
            raise ServiceError("Request body is too large.", 413)
        try:
            data = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ServiceError("Request must contain valid JSON.") from exc
        if not isinstance(data, dict):
            raise ServiceError("Request body must be a JSON object.")
        return data

    def _check_origin(self):
        host = self.headers.get("Host", "").lower()
        if host not in (f"127.0.0.1:{self.server.server_port}",
                        f"localhost:{self.server.server_port}"):
            raise ServiceError("Requests must use the local LogStation address.", 403)
        origin = self.headers.get("Origin")
        if origin:
            parsed = urlparse(origin)
            if parsed.netloc.lower() != host or parsed.scheme not in ("http", "https"):
                raise ServiceError("Cross-origin requests are not allowed.", 403)

    def _source(self, source_id):
        with sources_lock:
            source = sources.get(source_id)
        if source is None:
            raise ServiceError("Source not found.", 404, "not_found")
        return source

    def do_GET(self):
        try:
            self._check_origin()
            parsed = urlparse(self.path)
            if parsed.path == "/api/contexts":
                contexts, active = kube_contexts()
                self._send_json({"contexts": contexts, "active": active})
            elif parsed.path.startswith("/api/namespaces/"):
                context_name = unquote(parsed.path.removeprefix("/api/namespaces/"))
                try:
                    items = kube_api(context_name).list_namespace().items
                except ServiceError:
                    raise
                except (ApiException, urllib3.exceptions.HTTPError, OSError) as exc:
                    raise ServiceError(
                        f"Could not list namespaces: {getattr(exc, 'reason', None) or exc}",
                        502, "kubernetes_error",
                    ) from exc
                self._send_json({"namespaces": [item.metadata.name for item in items]})
            elif parsed.path == "/api/sources":
                with sources_lock:
                    items = [public_source(item) for item in sources.values()]
                self._send_json({"sources": items})
            elif parsed.path.startswith("/api/sources/"):
                parts = parsed.path.strip("/").split("/")
                if len(parts) == 4 and parts[3] == "files":
                    source = self._source(unquote(parts[2]))
                    self._send_json({"files": list_files(source)})
                elif len(parts) == 4 and parts[3] == "logs":
                    source = self._source(unquote(parts[2]))
                    query = parse_qs(parsed.query)
                    item_id = query.get("file", [""])[0]
                    self._send_json({
                        "logs": get_logs(source, item_id, parse_tail_lines(parsed.query))
                    })
                else:
                    raise ServiceError("Endpoint not found.", 404)
            else:
                self._serve_asset(parsed.path)
        except ServiceError as exc:
            self._send_error(exc)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, TypeError, KeyError, IndexError, UnicodeError) as exc:
            self._send_error(ServiceError(f"Unexpected server error: {exc}", 500))

    def do_POST(self):
        try:
            self._check_origin()
            parsed = urlparse(self.path)
            data = self._read_json()
            if parsed.path == "/api/test-source":
                self._send_json(test_source(data))
            elif parsed.path == "/api/sources":
                validate_source(data)
                data["id"] = uuid.uuid4().hex
                data["name"] = data.get("name", "").strip() or default_name(data)
                with sources_lock:
                    sources[data["id"]] = data
                try:
                    save_sources()
                except OSError as exc:
                    with sources_lock:
                        sources.pop(data["id"], None)
                    raise ServiceError(f"Could not save source: {exc}", 500) from exc
                self._send_json({"source": public_source(data)}, 201)
            elif parsed.path.startswith("/api/sources/") and parsed.path.endswith("/credentials"):
                source_id = unquote(parsed.path.split("/")[3])
                source = self._source(source_id)
                if source["type"] != "ssh":
                    raise ServiceError("Only SSH sources use credentials.")
                password = data.get("password")
                if not isinstance(password, str) or not password:
                    raise ServiceError("Enter a password.")
                updated = {**source, "password": password}
                test_source(updated)
                with sources_lock:
                    source["password"] = password
                self._send_json({"ok": True})
            else:
                raise ServiceError("Endpoint not found.", 404)
        except ServiceError as exc:
            self._send_error(exc)
        except (BrokenPipeError, ConnectionResetError):
            return
        except (OSError, ValueError, TypeError, KeyError, IndexError, UnicodeError) as exc:
            self._send_error(ServiceError(f"Unexpected server error: {exc}", 500))

    def do_DELETE(self):
        try:
            self._check_origin()
            parts = urlparse(self.path).path.strip("/").split("/")
            if len(parts) != 3 or parts[:2] != ["api", "sources"]:
                raise ServiceError("Endpoint not found.", 404)
            source_id = unquote(parts[2])
            with sources_lock:
                if sources.pop(source_id, None) is None:
                    raise ServiceError("Source not found.", 404, "not_found")
                save_sources()
            self._send_json({"ok": True})
        except ServiceError as exc:
            self._send_error(exc)
        except OSError as exc:
            self._send_error(ServiceError(f"Could not update saved sources: {exc}", 500))

    def _serve_asset(self, path):
        name = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        if name not in ("index.html", "app.js", "styles.css"):
            self.send_error(404)
            return
        try:
            body = asset_path(name).read_bytes()
        except OSError as exc:
            raise ServiceError(f"Could not read web asset {name}: {exc}", 500) from exc
        content_type = {
            "index.html": "text/html; charset=utf-8",
            "app.js": "text/javascript; charset=utf-8",
            "styles.css": "text/css; charset=utf-8",
        }[name]
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self'; script-src 'self'; "
                         "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def default_name(source):
    if source["type"] == "kubernetes":
        return source.get("context", "Kubernetes")
    if source["type"] == "ssh":
        return source.get("host", "SSH")
    return Path(source["paths"][0]).name


def main():
    parser = argparse.ArgumentParser(description="A universal browser-based log viewer.")
    parser.add_argument("--start", action="store_true", help="Start the LogStation web server.")
    parser.add_argument("--port", type=int, default=3000, help="HTTP port (default: 3000).")
    args = parser.parse_args()
    if not args.start:
        parser.error("Use --start to run LogStation.")
    if not 1 <= args.port <= 65535:
        parser.error("--port must be between 1 and 65535.")
    load_sources()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"{APP_NAME} is ready at http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping LogStation.", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
