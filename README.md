# LogStation

LogStation is a browser-based log viewer for local files, SSH hosts, and Kubernetes pods. The web UI and server are packaged into one executable.

## Run

Download or build the executable, then start it:

```sh
./logStation --start --port=3000
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). The server binds to loopback only; it is intended for a browser on the same machine.

## Build the standalone binary

Python 3.10+ and pip are needed only to build. From this directory:

```sh
python3 -m pip install -r requirements.txt
python3 -m PyInstaller --clean --onefile --name logStation \
  --add-data "web:web" --distpath . logstation.py
```

The resulting `./logStation` contains the server and web assets. Build it on the target operating system and CPU architecture.

## Connect sources

- **Kubernetes:** Uses the current OS user's default kubeconfig (`~/.kube/config`) and its contexts. Pick a context and namespace; each pod container is shown as a stream.
- **SSH:** Provide a host, username, password, and one absolute log path per line. SSH host keys must already be trusted in the user's `known_hosts`; unknown hosts are rejected. The password stays in process memory and is never written to the source file. After a restart, enter it again when reconnecting.
- **Local files:** Enter one readable file path per line on the machine running LogStation.

Saved source metadata is stored in `~/.logstation/sources.json` with owner-only permissions (or `$LOGSTATION_HOME/sources.json` when that environment variable is set). Local file paths and Kubernetes contexts are read with the OS user's permissions.

The viewer tails the latest 300 lines and polls every 2.5 seconds. Use the theme button for dark/light mode, and the pause and filter controls in the viewer.

## Development

```sh
python3 -m pip install -r requirements.txt
python3 -m unittest
python3 logstation.py --start --port=3000
```
