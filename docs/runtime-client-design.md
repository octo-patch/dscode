# Runtime and client separation: design

> **Design record, not a usage guide.** It records the decisions, evidence and plan for separating the DSCODE runtime from its terminal client. Behaviour follows the code; nothing here is a user-facing feature yet.

Status: P0–P2 implemented in 0.7.47 (2026-10-14). The terminal reaches the runtime only through `RuntimeClient`; `dscode` runs it as a separate client of a background Host by default, with `--in-process` keeping one process. Remote access shipped in 0.7.48 as a token-authenticated, unencrypted TCP listener (`dscode server`; see [Remote runtime](remote-runtime.md)); the Hub relay remains deferred. The user guide is [Background host](host.md); the protocol as implemented is specified in [Client and runtime protocol](runtime-protocol.md).

## Goal and decisions

Any client, eventually including one across the network, should be able to drive a DSCODE session without running inside the runtime process. Today the TUI is a Cordis plugin in the same process and root context as the agents, LLM, tools and permissions, and it even creates and resumes Agents itself (`packages/tui/src/index.ts` around `run()`).

Decided on 2026-10-14:

| Decision | Choice | Reason |
|---|---|---|
| Protocol | Upstream DSH Typert RPC | Web and the official Desktop already use it as a decoupled client protocol; it is typed and covers sessions, streaming, approvals, settings and credentials. Gaps are filled with DSCODE `@Remote` services rather than by growing the session bridge or making ACP primary |
| Local carrier | Owner-only Unix socket | Filesystem permissions authenticate, as for the session bridge; the upstream browser carrier's cookie and loopback checks do not apply to a non-browser client |
| Host lifecycle | Auto-start; exit after idle | The first `dscode` starts a host if none is running; the host exits after a period with no client and no running turn |
| Scope | P0–P2 | Remote access (SSH forwarding or the Hub relay in [Cloud web app host](cloud-webapp-host.md)) is deferred |

## Upstream protocol in brief

Pinned DSH 0.2.0-rc.2 provides `dsh-api-gateway` (dispatch), `dsh-api-remotes` (the selected namespaces and the forwarded-event allowlist), the `dsh-api-*-controller` packages and `dsh-client-connection` (transport). Unary calls carry `{type: 'client-request', rpcId, method, payload}` to `/api/<namespace>/<method>`; every payload is `{args: {<parameter>: value}}`, for example `{args: {request: {...}}}`. Streams are logical: the Host side exposes `typertGateway.wireStream.open(endpoint, payload, uplink, peer, signal)` and the client side accepts an `openStream(endpoint, payload, signal, uplink)` hook in `ClientTransportHooks`, so the physical carrier is replaceable at both ends.

Interactive requests travel on the `$events` stream (payload `{args: {}}`). It opens with `{type: 'ready', clientId}`, delivers one-way events as `emit` frames and Agent-scoped waterfalls such as `approval/request` as `waterfall` frames with an `eventId`. A client answers through `$events/result` with `{args: {clientId, eventId, outcome}}`, where an approval outcome value is `allowed-once`, `rejected`, `cancelled` or `unavailable`. Pending waterfalls go to every client and are replayed on reconnect; the first answer wins.

## P0 evidence

`plugins/local-carrier/index.mjs` serves an owner-only socket (directory 0700, socket 0600; nothing on TCP). Unary requests go to `connection.createSharedFetchHandler('/api')`, which speaks for the operator peer; `POST /stream` carries one logical stream per HTTP exchange as NDJSON: the request body opens with `{endpoint, payload}` followed by uplink items, and the response carries `{item}` lines ending in exactly one `{end}` or `{error}`. `plugins/local-carrier/client.mjs` provides `call`, `openStream` and `transportHooks(socketPath)` for `installConnection(ctx, {transport})`.

`scripts/verify-local-carrier.mjs` boots a real headless Harness (TUI rows disabled, `dsh-api-remotes` and the carrier inserted, a deterministic fixture model) and drives it from a separate process using upstream methods only. It verified:

- `session/create` with the `dscode` preset, `session/selectModel`, and two `session/prompt` turns.
- `session/follow` with `assistantStream: true`: 35 live `text-delta` frames per reply, settled by the durable `assistant/message` event.
- An escalated `write` outside every writable root raised `approval/request` on `$events` with `toolName`, `callId`, `reason` and localized `displayReason`. Answering `rejected` produced the tool's rejection result, and no file was created.

The approval frame does not carry tool arguments, but its `callId` matches the `tool/call` event on the follow stream, which does. A client can therefore show the exact operation without a protocol change. `tests/local-carrier.test.mjs` covers the envelope, socket permissions and removal, uplink, failure mapping and client abort.

## Coverage against the terminal

| Terminal need | Upstream coverage |
|---|---|
| Create, list, fork, rename, search, page sessions | `session/*` |
| Prompt and steer, inbox edits, cancel | `session/prompt` (`queue`/`steer`), `session/updateQueue`, `session/cancel` |
| Streaming output and committed events | `session/follow`; subagent addresses supported |
| Model and effort selection, catalogs | `session/selectModel`, `session/modelCatalog`, `llm/*` |
| Slash commands | `commands/list`, `commands/execute` |
| Settings and credentials | `settings/*`, `credentials/*` |
| Approvals and ask-user questions | `$events` waterfalls, `userQuestions/answer` |
| Skills, file references, jobs, goals, schedules, subagents, agent presets | the corresponding namespaces |
| Attachments | `session/prompt` image parts, `fileUploads/upload` |
| Per-session live values | `session/control` projections; DSCODE can register its own projection keys |

Gaps that P1 must close:

1. **Per-session permission preset changes.** Only `permissionPresets/catalog` is remote; the terminal applies presets in process.
2. **Provider authorization.** `authorization.begin` takes an in-process `{notify, prompt}` interaction with hidden input; there is no remote equivalent.
3. **DSCODE footer and status state.** Spend, TPS, cache, speed tier, delegation board, Grok status and pricing thresholds pass through module singletons (`registerStatusSelection`, `setMetricSource`, `speedLabel`, `delegateBoardFor`, …) that need one JS heap. They should become session projections or a `dscode/*` service.
4. **Host logic inside the UI.** Agent creation and resume, the subagent model-reroute waterfall on `agent/request`, side questions, OpenRouter account calls that resolve key values in `app.ts`, and the Gmail/IMAP connectors must move to the host.
5. **Resume of an exited session, deletion and export** need explicit host operations; the terminal currently resumes in process and removes artifact directories itself.

Client-local behaviour stays in the client: raw terminal mode, clipboard, terminal title, editor integration, preferences and update checks. Where the client and host share a machine, the working directory is passed explicitly at session creation instead of being read from the host's `process.cwd()`.

## Plan

**P1 — the terminal behind one client interface.** Introduce a `RuntimeClient` interface for everything `index.ts` and its helpers take from the host, with an in-process implementation preserving today's behaviour and a Typert implementation over `transportHooks`. Move the host logic listed above into host plugins and add the missing DSCODE `@Remote` services and projections. Done when the terminal imports no runtime service except through that interface and its tests pass against the Typert implementation.

**P2 — a separate host process.** Add `dscode host` (start, stop, status) that mounts the carrier at `$DSCODE_HOME/run/host.sock`; `dscode` connects to it and starts one when absent. The host exits after an idle period with no client and no running turn. Several terminals can attach to one session, and a terminal can reattach after a crash. The single-writer `session.lock` and the installation lock continue to apply.

**Deferred — remote access.** SSH forwarding of the socket is the smallest step; the Hub relay with end-to-end encryption is designed in [Cloud web app host](cloud-webapp-host.md).

## P1 progress

`scripts/verify-tui-runner.mjs` is the behaviour baseline for the refactor; it runs every scenario once per runtime. It boots the real Harness and TUI rows against the fixture model, mounts the terminal on an in-memory TTY through the `internals` seam (`scripts/tui-runner-probe.mjs`) and types like a user: a streamed reply, an escalated write rejected with `n` in the approval bar, an `ask_user_question` answered with Enter, `/quit`, then a second boot that resumes the session and repaints its history. It runs in the integration checks.

`packages/tui/src/runtime/types.ts` defines `RuntimeClient` (open, persisted headers, liveness, committed-event and assistant-stream subscriptions) and `RuntimeSession` (header, events, request route, status, idle wait, next-turn queue, followup/steer/inject/cancel, flush, dispose). Its read members keep the native `Session` names so read-only call sites are unchanged. `runtime/in-process.ts` holds the composition the runner used to do inline: preset mount, model-selection install, status selection and the pre-session permission. The runner's open, switch, delivery, queue edits, interrupt, quit and event feeds now go through these interfaces, and the baseline passed unchanged after the move.

Approvals and questions arrive as protocol-neutral asks (`onApprovalRequest`, `onQuestionRequest`); an answerer returns undefined to pass an ask on, matching the waterfall's `next()`.

`runtime/typert.ts` implements the same interfaces over the carrier. The runner selects it when `DSCODE_RUNTIME_SOCKET` names a Host socket. Each opened session mirrors its `session/follow` stream (snapshot page, then committed events and live assistant frames); status comes from `api-session/status` and turn events; prompts go through `session/prompt` and cancellation through `session/cancel`. A resume needs no call of its own: the Host's session controller resumes the session when the follow stream resolves it. Approvals and questions are answered through `$events/result`, and an ask the terminal does not claim is returned with `next`. In the baseline's protocol mode the Host and terminal still share one process, but the terminal reaches the session only through the socket.

Superseded during P1 (kept for the record): Not yet carried by the protocol implementation: session references (`inject`), next-turn queue edits, forks, image attachments, the pre-session permission choice and history older than the follow snapshot's page. Commands, skills, mentions, `/btw`, permission presets, titles, usage and jobs still need `RuntimeSession.native` and degrade without it, and the subagent model reroute still listens on the in-process bus.

## P1 completion and P2

**DSCODE Host operations.** Upstream Typert covers the session core; everything DSCODE-specific is a registry of named methods and streams in `packages/tui/src/host/` (the `tui-host` plugin): commands, models and the `/subagent` override (including the subagent reroute, now Host-wide), provider settings, credentials and interactive login, the OpenRouter account, custom providers, the session catalog, jobs, reminders, plugins, permission presets, skills, @-mentions and session references, attachments from local paths, delivery, queue edits, interrupts, `/btw`, child-session events, footer status and Host notices. The local carrier serves them as `POST /dscode/<name>` and `dscode/<name>` streams; the in-process runtime invokes the same registry directly with JSON-normalized arguments, so one implementation serves both. `run()` in `packages/tui/src/index.ts` takes a `RunnerEnvironment` and no Cordis context; `RuntimeSession` keeps only reads, status, idle wait, flush, release and model selection. Secret-reading OpenRouter helpers moved out of `app.ts` to the Host.

**Separate client.** `runTerminalClient` (`dsh-code/client`, started by `scripts/terminal-client.mjs`) parses the terminal arguments without a Harness and mirrors the Host's footer sources (`setMetricSource`, `setSpeedSource`, `setBoardSource`) from `status/watch`.

**Host process.** `scripts/host.mjs` composes the terminal profile without its UI rows and without the process-wide hooks bridge, adding `dsh-api-remotes`, the carrier in Host mode and `plugins/desktop-workspace`, which mounts instructions, ancestor skill roots and hooks per session from the session's folder. `DSCODE_SESSION_WORKSPACES=1` disables the preset's environment-based `agent-instructions` and `skill-filesystem` rows (the Desktop build turns the same switch on unconditionally). The carrier takes an exclusive lock beside the socket before replacing a stale one; a Host that loses the lock exits, and `ensureHost` starts again until one answers. Idle exit counts attached terminals by their `$events` streams and ignores `host/status` probes. In a self-contained package the Host is launched through the package's own launcher, so it holds the installation lock and run lease; `dscode update` stops an idle Host first.

**Evidence.** `scripts/verify-tui-runner.mjs` runs sixteen terminal behaviours plus resume in single-process, same-process protocol and separate-Host modes (the last through the real launcher, asserting a separate Host PID). `scripts/verify-host.mjs` covers two clients on one session, a terminal killed mid-turn and reattached, concurrent starts, idle exit, and per-session ancestor instructions on one Host. The baseline also exposed and fixed a pre-existing `/btw` failure: a child with an inherited prefix lacked the seeded marker.

## Remote access (0.7.48)

Decided on 2026-10-15. The user asked for `dscode server --port N` on the server, `dscode config --runtime host:port --alias NAME --set-default` on the client, and `dscode runtime NAME` or bare `dscode` to attach. Three security models were offered: TLS with a pinned self-signed certificate and a token, a token over plain HTTP, and loopback only behind an SSH tunnel. The user chose the token over plain HTTP, for use on networks that are already encrypted (VPN, Tailscale, LAN). The server prints that traffic is unencrypted, and the guide repeats it.

The listener reuses the carrier's routes unchanged; only an authorization gate and connection settings were added. The protocol therefore stays the one specified in [Client and runtime protocol](runtime-protocol.md), and the TCP form is just another target for the same client. The parts of the terminal that assumed a shared filesystem moved behind `RuntimeClient.sharesFilesystem`:

- Attachments a remote terminal can read locally are sent as content; other paths go to the Host.
- Git inspection and the status-line branch became Host operations in every mode.
- `/export` writes through the Host when the filesystem is not shared.

The session folder comes from the launcher, never from the client's `process.cwd()`. Reconnection was added because a network drops connections that a local socket never does: it applies to local and remote clients alike, and a follow stream fills its gap from history pages.

Still deferred: encryption, per-user accounts and the Hub relay.

## Risks

- DSH is a release candidate; the Typert surface may change between pins, and DSCODE already patches upstream packages in places.
- The local carrier relies on `wireStream` and `createSharedFetchHandler`, which upstream documents for local Host transports but which are not covered by an upstream compatibility promise.
- One-way events are not replayed on reconnect; any state the terminal needs after a reconnect must come from a query, cursor or opening baseline.
