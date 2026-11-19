import json
import os
import tempfile
import unittest
from unittest.mock import patch

import logstation


class LogStationTests(unittest.TestCase):
    def test_tail_returns_last_300_lines(self):
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8") as file:
            file.write("\n".join(f"line {number}" for number in range(305)))
            file.flush()
            lines = logstation.read_local_tail(file.name).splitlines()
        self.assertEqual(len(lines), 300)
        self.assertEqual(lines[0], "line 5")
        self.assertEqual(lines[-1], "line 304")

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

    def test_kubernetes_source_requires_context_and_namespace(self):
        with self.assertRaises(logstation.ServiceError):
            logstation.validate_source({"type": "kubernetes", "context": "", "namespace": ""})


if __name__ == "__main__":
    unittest.main()
