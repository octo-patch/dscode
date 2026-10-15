# Background host

Since DSCODE 0.7.47 the terminal and the agent runtime run as separate processes. The first `dscode` in a state directory starts a background **host** that owns sessions, models, tools, permissions and credentials; each terminal attaches to it as a client. Closing a terminal no longer stops its work, several terminals can attach to the same session, and a terminal that crashes can reattach.

Everything stays on your machine. The host listens only on a Unix socket (`host.sock`, mode 0600) in a private per-user directory under `/tmp` that is derived from the state directory and checked for ownership and mode 0700; nothing listens on TCP. The short location keeps the path within the macOS socket limit. To reach a host from another machine, start it as `dscode server` instead; see [Remote runtime](remote-runtime.md).

## Everyday use

Nothing changes in how you start DSCODE: run `dscode` in a project folder. If no host is running, the launcher starts one in the background and waits until it answers (usually about a second), then opens the terminal. `dscode --resume <id>`, `--continue`, `--session` and an initial prompt work as before.

When you quit a terminal, the session stays available on the host. A turn that is still running keeps running; `dscode --resume <id>` from any terminal attaches to it, shows its history and can interrupt it with Esc. Approvals and questions are offered to every terminal attached to that session, and the first answer settles them (the upstream protocol's rule; DSCODE's automated checks exercise a single answering terminal).

The host exits by itself after ten minutes with no attached terminal and no running turn. Set `DSCODE_HOST_IDLE_MS` (milliseconds, `0` to never exit) before the first `dscode` to change this.

## Commands

| Command | Result |
|---|---|
| `dscode host status` | The running host's process ID, attached terminals, live sessions and running turns; exit code 3 when none runs |
| `dscode host start` | Start a host if none answers, and wait until it is ready |
| `dscode host stop` | Ask the host to exit and wait until its process is gone |
| `dscode host serve` | Run the host in the foreground (diagnostics) |

The host writes its output to `run/host.log` in the state directory. For a self-contained installation that is `~/.local/share/dscode-state/run/`.

## One host, many folders

A single host serves every folder you open. Each session reads the `AGENTS.md`/`CLAUDE.md` instructions, ancestor skill folders and project hooks of its own folder, not of the folder the host happened to start in. The session's folder is fixed when it is created, as before.

## Picking up configuration changes

The host keeps running when you quit a terminal, so quitting and starting `dscode` again no longer reloads configuration. Use `/reload` in any session instead:

| You changed | Picked up |
|---|---|
| A skill in the project's `.dsh/skills` or `.agents/skills`, or in your user skill folder | Automatically, while the session runs |
| `config/mcp.local.yml` or `config/harness.local.yml` (including creating one) | After `/reload`; MCP servers that were added start, removed ones stop, changed ones restart, and unchanged ones keep their connections |
| A new `.dsh/skills`, `.agents/skills` or `.claude/skills` folder above the project, an `AGENTS.md`/`CLAUDE.md` above the project, or a hook layer | After `/reload`, for the session you run it in; other sessions pick it up when they run `/reload` or are created |

MCP servers and the overlays are shared by every session on the host, so `/reload` changes them for all of them and waits until no agent is running. A file that does not parse is reported and the running configuration stays as it was. `dscode host stop` followed by `dscode` still restarts everything.

## Single-process mode

`dscode --in-process` (or `DSCODE_RUNTIME=in-process`) runs the terminal and runtime in one process, as in earlier releases. If the host cannot start, the launcher says why and continues in single-process mode. A session that a host is driving cannot be opened by a single-process terminal at the same time; that terminal exits with `session … is already owned by an active write handle`.

## Updates

`dscode update` stops a host that has no attached terminal before replacing the package. While a terminal is attached it refuses and asks you to exit first. The in-terminal `/update` runs after you quit, by which time your terminal has detached.

## Limits

- The background host is reachable only by your user on this machine. Remote access goes through `dscode server` ([Remote runtime](remote-runtime.md)).
- `dscode exec`, `dscode acp` and the Desktop plugin keep their own runtimes and do not use the background host.
- A terminal shows a turn it joined from the next streamed text onward; text streamed before it attached appears once the turn's message is committed.
- If the host exits while a terminal is attached (for example `dscode host stop`), the terminal says it lost the connection and keeps retrying. It reconnects once a host answers again, for example after `dscode host start`; otherwise quit and start `dscode` again.

## Verification

`node scripts/verify-host.mjs` covers two clients on one session, a terminal killed mid-turn and reattached, concurrent starts converging on one host, idle exit, and per-session workspace instructions on a shared host. `node scripts/verify-remote.mjs` covers `dscode server`, `dscode config` and a terminal on a remote runtime, including a server restart mid-session. `node scripts/verify-tui-runner.mjs` drives the real terminal against the fixture model in single-process, same-process protocol and separate-host modes.
