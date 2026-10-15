# Remote runtime

Run the agent runtime on a server and the terminal on your own machine. Sessions, models, credentials, tools and files live on the server; the terminal only draws and sends input. The connection uses the same protocol as the local [background host](host.md), carried over TCP with a token.

> **Traffic is not encrypted.** The token, your prompts and the agent's output cross the network in plain text. Use a trusted network: a VPN such as Tailscale or WireGuard, a private LAN, or an SSH tunnel. Do not expose the port on the public internet.

## On the server

Install DSCODE on the server as usual, sign in to your model providers there (credentials stay on the server), then start the server in the folder you want sessions to default to:

```bash
cd ~/projects/app
dscode server --port 8080
```

It prints the command to run on your machine:

```
DSCODE server on 0.0.0.0:8080 (default folder /home/me/projects/app)
Traffic is NOT encrypted: use it on a trusted network (VPN, Tailscale, LAN) or through an SSH tunnel.
Connect a client with:
  dscode config --runtime 10.0.0.5:8080 --token dsk_… --alias devbox --set-default
```

`dscode server` runs in the foreground and never exits by idling; keep it in `tmux`, `screen` or a service manager. Stop it with Ctrl+C. Turns that are running stop with it, and sessions can be resumed after a restart.

| Option | Meaning |
|---|---|
| `--port PORT` | TCP port (required) |
| `--bind ADDRESS` | Address to listen on; default `0.0.0.0` (every interface). Use the VPN interface's address, or `127.0.0.1` with an SSH tunnel |
| `--cwd DIR` | Default folder for new sessions; default the folder you start it in |
| `--token TOKEN` | Use this token (at least 16 characters) instead of the stored one |
| `--new-token` | Replace the stored token; clients configured with the old one are refused |

The token is stored in `run/server-token` in the server's state directory (`~/.local/share/dscode-state/run/` for a self-contained installation), readable only by you, and reused on the next start.

A terminal on the server itself still works: plain `dscode` there attaches to the same runtime through its local socket, so you can share a session between the server and your machine. If a background host is already running when you start the server, it is stopped first when it has no attached terminal and no running turn; otherwise the server refuses to start until you exit those terminals.

## On your machine

Run the command the server printed:

```bash
dscode config --runtime 10.0.0.5:8080 --token dsk_… --alias devbox --set-default
```

It saves the runtime and reports whether it answers. Then:

| Command | Result |
|---|---|
| `dscode` | Start the terminal on the default runtime |
| `dscode runtime devbox` | Start the terminal on `devbox`, whatever the default is |
| `dscode runtime local` | Start the terminal on this machine |
| `dscode runtime` | List the configured runtimes; `*` marks the default |
| `dscode runtime devbox --resume <id>` | Every terminal option works after the alias |
| `dscode runtime devbox --cwd /srv/other` | Start the new session in another folder **on the server** |

Managing the list:

| Command | Result |
|---|---|
| `dscode config --list` | Same listing as `dscode runtime` (tokens are never shown) |
| `dscode config --default devbox` | Make `devbox` the default; `--default local` goes back to this machine |
| `dscode config --remove devbox` | Forget it; if it was the default, the default becomes `local` |
| `dscode config --runtime … --alias devbox --cwd /srv/app` | Re-adding an alias replaces it; `--cwd` gives it its own default folder |

The list is stored in `runtimes.json` in your state directory, readable only by you, because it holds the tokens.

The folder for a new session is, in order: `--cwd` on the command line, the alias's `--cwd`, then the server's default folder. It is a path on the server. `--continue` picks the newest session of that folder.

## What runs where

| On the server | On your machine |
|---|---|
| Models, provider credentials and logins | Drawing the terminal, keyboard and clipboard |
| Tools: shell commands, file reads and edits | Input history, theme and language |
| The session's `AGENTS.md`, skills and hooks | Your external editor |
| `@` file completion, `/diff`, `/review`, the status-line branch | |
| `/export` (writes into the session's folder on the server) | |

Configuration lives on the server too: after editing `config/mcp.local.yml` there, adding a skill folder or changing an `AGENTS.md`, run `/reload` from your terminal and the server re-reads its own files ([details](host.md#picking-up-configuration-changes)).

Pasted screenshots and dropped files are read on your machine and uploaded with the message. A path that does not exist on your machine is passed to the server, which resolves it in the session's folder.

## When the connection drops

The terminal says `lost the connection to runtime devbox; reconnecting…` and keeps trying, then `reconnected to runtime devbox`. Work on the server continues meanwhile. After reconnecting, the transcript is filled in with everything committed while you were away; text that was streaming at that moment appears once its message is committed. An approval or question that was still open closes when the connection drops; the server offers it again after reconnecting, and you answer it there.

## Versions

The terminal and the server do not have to run the same DSCODE release. Each release speaks a protocol version, `major.minor`, and two releases work together when the major matches. `dscode config` prints the server's release and protocol when it connects, and `dscode host status` on the server shows the protocol in its output. If the server is on an older minor than the terminal, the features added since are unavailable on that server. A server on DSCODE 0.7.48 or older predates protocol versions, and only the identical release can use it.

## Refusals

DSCODE never falls back to this machine when you asked for a remote runtime:

| Message | Fix |
|---|---|
| `runtime devbox refused the token` | The server's token changed (`--new-token`); copy the new `dscode config` line from the server's output |
| `runtime devbox (…) did not answer` | The server is not running, the address or port is wrong, or a firewall blocks it |
| `runtime devbox speaks protocol x.y (DSCODE …); this client speaks …` | The two releases are incompatible; update the side the message names |
| `runtime devbox runs DSCODE x, which predates protocol negotiation` | The server runs DSCODE 0.7.48 or older; update it |
| `no runtime named devbox` | `dscode config --list` shows the configured names |

## Limits

- No encryption and no user accounts: anyone holding the token has full control of the server's runtime, including its tools and credentials.
- One server per state directory, and every terminal acts as the same user.
- `dscode exec`, `dscode acp`, `dscode trigger` and `dscode host` act on this machine only.
- An editor or file link opened from the terminal opens on your machine, where the server's paths may not exist.
- A provider login whose browser step redirects to `localhost` must be completed on the server; start it from a terminal on the server.
