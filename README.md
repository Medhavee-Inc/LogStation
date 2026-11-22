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
- **Remote Kubernetes:** Enter an SSH host, username, and password, then load and choose a context and namespace from the remote machine. LogStation runs `kubectl` over SSH on that machine, so its installed `kubectl`, kubeconfig, and Kubernetes role are used. The remote host must have `kubectl` installed and available on the SSH user's `PATH`. Its host key follows the same trust-on-first-use verification as SSH sources. The password stays in process memory and is never written to the source file; enter it again after restarting LogStation.
- **SSH:** Provide a host, username, password, and one absolute log path per line. On first connection, LogStation accepts the host key and adds it to `~/.ssh/known_hosts`; later connections verify it against the saved key and reject changed keys. This trust-on-first-use behavior means you should verify the host key fingerprint through a trusted channel if possible. The password stays in process memory and is never written to the source file. After a restart, enter it again when reconnecting.
- **Local files:** Enter one readable file path per line on the machine running LogStation.

When adding any source, you can optionally set a custom tile title and choose an icon. If the title is blank, LogStation uses the source's name. Use the edit control on a source tile to update its title, icon, or connection details. When editing an SSH source, leave the password blank to keep the current in-memory password; if LogStation was restarted, enter a password only when changing the SSH host or username, or reconnect later.

Saved source metadata is stored in `~/.logstation/sources.json` with owner-only permissions (or `$LOGSTATION_HOME/sources.json` when that environment variable is set). Local file paths and local Kubernetes contexts are read with the OS user's permissions.

The viewer tails the latest 300 lines by default and polls every 2.5 seconds. Set the **Tail** count in the log toolbar to show between 1 and 10,000 lines; your choice is saved locally. Its height grows with the log output up to 50 lines, then scrolls vertically. Use **Hide files** / **Show files** to collapse or reopen the stream sidebar, and the theme, pause, filter, and **Wrap lines** controls as needed. By default, long lines scroll horizontally; **Wrap lines** toggles wrapping on and off.

## Development

```sh
python3 -m pip install -r requirements.txt
python3 -m unittest
python3 logstation.py --start --port=3000
```
