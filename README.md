# LogStation

<div align="center">

**One clean workspace for logs scattered across your machines and clusters.**

[![Version](https://img.shields.io/badge/version-1.0.7-2563eb?style=for-the-badge)](VERSION)
[![Python](https://img.shields.io/badge/Python-3.10+-3776ab?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20x86--64-blue?style=for-the-badge)](#installation)

_Watch, filter, and follow logs from local files, SSH servers, and Kubernetes — without switching tools._

</div>

## ✨ What it does

LogStation brings every log source into a focused browser dashboard:

- **Local files** — tail readable files on the machine running LogStation
- **SSH logs** — securely connect to remote servers and monitor log paths
- **Kubernetes** — browse contexts and stream pod container logs
- **Remote Kubernetes** — use a cluster through a remote `kubectl` host
- **Live controls** — pause, filter, wrap, theme, and adjust the tail length

## 🚀 Quick start

Download a standalone build or run it directly:

```bash
./logStation --start --port=3000
```

Open **http://127.0.0.1:3000** in your browser.

> LogStation listens only on loopback by default, so it is designed for a browser on the same machine.

## 🧩 Connect a source

Use **Add source** and choose the connection that fits:

| Source | What you need |
|:--|:--|
| **Local files** | One absolute or readable file path per line |
| **SSH** | Host, username, password, and remote log paths |
| **Kubernetes** | A kubeconfig context and namespace |
| **Remote Kubernetes** | SSH access plus `kubectl` and kubeconfig on the remote host |

Source titles and icons are customizable. Live controls include **Pause**, **Filter logs**, **Tail**, **Wrap lines**, **Hide files**, and light/dark themes.

## 📦 Installation

### Standalone executable

Run the build matching your operating system and CPU architecture. No Python installation is required for prebuilt binaries.

### Build from source

```bash
python3 -m pip install -r requirements.txt
python3 -m PyInstaller --clean --onefile --name logStation \
  --add-data "web:web" --distpath . logstation.py
```

Build on the target operating system and CPU architecture. The resulting executable contains both the server and web interface.

## 🛠️ Development

```bash
python3 -m pip install -r requirements.txt
python3 -m unittest
python3 logstation.py --start --port=3000
```

## 🔐 Security and storage

- SSH passwords are kept in memory only and are never written to disk
- Saved source metadata lives in `~/.logstation/sources.json`
- Set `LOGSTATION_HOME` to change the source metadata location
- Source metadata files are created with owner-only permissions
- SSH host keys are saved in `~/.ssh/known_hosts` and verified on later connections

## About LogStation

LogStation is a compact, browser-based log viewer that combines local file tails, SSH sessions, Kubernetes container streams, and remote Kubernetes access into one executable.

When it starts, LogStation serves a responsive web dashboard from a local Python HTTP server. Each source is displayed as a tile, while selecting a source reveals its available log streams. The viewer requests the latest lines from the server and refreshes them automatically, making it useful for checking application behavior, deployment output, and infrastructure logs in one place.

The default tail size is **300 lines**, refreshing every **2.5 seconds**. Tail size can be changed from **1 to 10,000 lines** and is saved in the browser. Output is horizontally scrollable by default, with optional line wrapping.

### Kubernetes

For local Kubernetes sources, LogStation uses the operating system user's default kubeconfig and the selected context and namespace. Every container in a matching pod is exposed as an individual stream.

For remote Kubernetes sources, LogStation connects over SSH and runs `kubectl` on the remote machine. That host must have `kubectl` on the SSH user's `PATH`, plus the appropriate kubeconfig and Kubernetes permissions.

### SSH and local logs

SSH sources accept one absolute log path per line. On the first connection, LogStation follows a trust-on-first-use host-key flow and verifies saved keys during later connections.

Local sources read files with the operating system user's permissions. Source metadata can be saved, edited, reordered, themed, and reopened between sessions.
