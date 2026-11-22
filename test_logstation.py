import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import logstation
import paramiko


class LogStationTests(unittest.TestCase):
    def test_tail_returns_last_300_lines(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as file:
            file.write("\n".join(f"line {number}" for number in range(305)))
            file.flush()
            lines = logstation.read_local_tail(file.name).splitlines()
        self.assertEqual(len(lines), 300)
        self.assertEqual(lines[0], "line 5")
        self.assertEqual(lines[-1], "line 304")

    def test_tail_returns_requested_number_of_lines(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as file:
            file.write("\n".join(f"line {number}" for number in range(5)))
            file.flush()
            lines = logstation.read_local_tail(file.name, 2).splitlines()
        self.assertEqual(lines, ["line 3", "line 4"])

    def test_tail_line_count_validation(self):
        self.assertEqual(logstation.parse_tail_lines("file=log&lines=42"), 42)
        self.assertEqual(logstation.parse_tail_lines("file=log"), logstation.TAIL_LINES)
        for query in ("lines=", "lines=0", "lines=10001", "lines=invalid"):
            with self.subTest(query=query), self.assertRaises(logstation.ServiceError):
                logstation.parse_tail_lines(query)

    def test_public_source_never_exposes_ssh_password(self):
        source = {"type": "ssh", "host": "host", "password": "do-not-return"}
        public = logstation.public_source(source)
        self.assertNotIn("password", public)
        self.assertFalse(public["requiresPassword"])
        source["password"] = ""
        self.assertTrue(logstation.public_source(source)["requiresPassword"])

    def test_saved_source_metadata_omits_password(self):
        source = {
            "id": "test-id", "type": "ssh", "name": "server",
            "host": "host", "username": "user", "password": "do-not-save",
            "paths": ["/var/log/app.log"],
        }
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"LOGSTATION_HOME": directory}):
                with patch.dict(logstation.sources, {"test-id": source}, clear=True):
                    logstation.save_sources()
                    stored = json.loads(logstation.sources_file().read_text())
                    self.assertNotIn("password", stored[0])

    def test_remote_kubernetes_password_is_not_saved(self):
        source = {
            "id": "test-id", "type": "remote-kubernetes", "name": "cluster",
            "host": "host", "username": "user", "password": "do-not-save",
            "context": "prod", "namespace": "default",
        }
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(os.environ, {"LOGSTATION_HOME": directory}):
                with patch.dict(logstation.sources, {"test-id": source}, clear=True):
                    logstation.save_sources()
                    stored = json.loads(logstation.sources_file().read_text())
                    self.assertNotIn("password", stored[0])
                    self.assertTrue(stored[0]["requiresPassword"])

    def test_remote_kubernetes_source_requires_ssh_and_cluster_details(self):
        source = {
            "type": "remote-kubernetes", "host": "host", "username": "user",
            "password": "secret", "context": "", "namespace": "",
        }
        with self.assertRaises(logstation.ServiceError):
            logstation.validate_source(source)
        source.update(context="prod", namespace="default")
        logstation.validate_source(source)
        source["password"] = ""
        with self.assertRaises(logstation.ServiceError) as error:
            logstation.validate_source(source)
        self.assertEqual(error.exception.code, "password_required")

    @patch("logstation.remote_command")
    def test_remote_kubernetes_contexts_are_read_from_remote_kubeconfig(self, remote_command):
        remote_command.return_value = json.dumps({
            "current-context": "prod",
            "contexts": [
                {"name": "prod", "context": {"cluster": "cluster-a"}},
                {"name": "stage", "context": {"cluster": "cluster-b"}},
            ],
        })
        contexts, active = logstation.remote_kube_contexts({
            "host": "host", "username": "user", "password": "secret",
        })
        self.assertEqual(contexts, [
            {"name": "prod", "cluster": "cluster-a"},
            {"name": "stage", "cluster": "cluster-b"},
        ])
        self.assertEqual(active, "prod")
        remote_command.assert_called_once_with(
            {"host": "host", "username": "user", "password": "secret"},
            ["kubectl", "config", "view", "-o", "json"],
        )

    @patch("logstation.remote_kube_command")
    def test_remote_kubernetes_log_streams_and_tail_use_remote_kubectl(self, remote_command):
        source = {
            "type": "remote-kubernetes", "context": "prod", "namespace": "default",
        }
        remote_command.return_value = json.dumps({"items": [{
            "metadata": {"name": "api"},
            "spec": {"containers": [{"name": "web"}, {"name": "metrics"}]},
        }]})
        files = logstation.list_files(source)
        self.assertEqual([item["label"] for item in files], ["web", "metrics"])

        remote_command.return_value = "2024-01-01T00:00:00Z started\n"
        self.assertEqual(
            logstation.get_logs(source, files[0]["id"], 25),
            "2024-01-01T00:00:00Z started",
        )
        self.assertEqual(remote_command.call_args.args[1], [
            "logs", "api", "--container", "web", "--tail", "25", "--timestamps",
        ])

    @patch("logstation.paramiko.SSHClient")
    def test_ssh_connect_saves_unknown_host_keys(self, ssh_client):
        source = {"host": "example.com", "username": "user", "password": "secret"}
        with tempfile.TemporaryDirectory() as home:
            known_hosts = Path(home) / ".ssh" / "known_hosts"
            with patch.object(Path, "home", return_value=Path(home)):
                self.assertIs(logstation.connect_ssh(source), ssh_client.return_value)
            self.assertTrue(known_hosts.is_file())
            ssh_client.return_value.load_host_keys.assert_called_once_with(str(known_hosts))
            policy = ssh_client.return_value.set_missing_host_key_policy.call_args.args[0]
            self.assertIsInstance(policy, paramiko.AutoAddPolicy)

    def test_kubernetes_source_requires_context_and_namespace(self):
        with self.assertRaises(logstation.ServiceError):
            logstation.validate_source({"type": "kubernetes", "context": "", "namespace": ""})


if __name__ == "__main__":
    unittest.main()
