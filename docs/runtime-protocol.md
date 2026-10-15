# Client and runtime protocol

> **Developer reference, not a usage guide.** It specifies how a terminal client talks to the DSCODE runtime, for anyone writing or debugging a client. Status: describes the protocol as implemented in 0.7.48; the code is authoritative where the two differ. Why it is shaped this way is in [Runtime and client separation](runtime-client-design.md); the user-facing behaviour is in [Background host](host.md) and [Remote runtime](remote-runtime.md).

## Roles

| Role | What it is | Code |
|---|---|---|
| **Host** | One Harness process per state directory. It owns sessions, agents, models, tools, permissions, credentials and persistence. | `scripts/host.mjs`, `plugins/local-carrier/index.mjs`, `packages/tui/src/host/` |
| **Client** | A process that renders and drives sessions without owning any of them. The terminal is the only client DSCODE ships. | `packages/tui/src/client.ts`, `packages/tui/src/runtime/typert.ts` |
| **Carrier** | HTTP over an owner-only Unix socket between the two; `dscode server` adds the same routes over TCP with a bearer token. | `plugins/local-carrier/index.mjs` (server), `plugins/local-carrier/client.mjs` (client) |

The protocol has two layers, both on the same socket:

- **Typert**, the upstream DSH RPC that the official Web and Desktop clients also use. It covers the session core: create, follow, page, fork, model selection, prompts, cancellation, approvals and questions.
- **DSCODE operations**, a registry of named methods and streams for everything DSCODE adds on top: slash commands, delivery with session references, queue edits, provider settings and login, catalogs, `/btw`, child-session feeds, footer status and notices.

```
 terminal client                                Host (Harness)
 ┌─────────────────────┐   host.sock (0600)    ┌──────────────────────────────┐
 │ RuntimeClient       │  POST /api/<method>   │ dsh-api-gateway  (Typert)    │
 │  (runtime/typert)   │ ────────────────────▶ │                              │
 │                     │  POST /dscode/<name>  │ tui-host registry (DSCODE)   │
 │                     │ ────────────────────▶ │                              │
 │                     │  POST /stream (NDJSON)│ wireStream / registry.open   │
 │                     │ ◀───────────────────▶ │                              │
 └─────────────────────┘                       └──────────────────────────────┘
```

In single-process mode (`--in-process`) the same `RuntimeClient` interface is implemented by `runtime/in-process.ts`, which reads live objects and invokes the same registry directly. Arguments and results go through `JSON.parse(JSON.stringify(…))` there too, so a DSCODE operation behaves identically in both modes.

## Transport

### Socket

The socket is `host.sock` in the session bridge's per-state directory under `/tmp` (`ensureSocketDirectory` in `plugins/session-bridge/paths.mjs`), which keeps the path inside the macOS limit of about 104 bytes. The directory is checked for ownership and mode 0700; the socket is chmod 0600 once listening. Nothing listens on TCP. **Filesystem permissions are the only authentication**: any process running as the same user can connect, and every connection acts as the Host's operator peer.

Before replacing a stale socket, a Host takes an exclusive `flock` on `host.lock` beside it. A Host that cannot take the lock exits with code 3, so exactly one Host serves a state directory.

### TCP listener

`dscode server --port PORT` runs the same Host with a second HTTP server on `bind:port` (default `0.0.0.0`) carrying the same three routes. The Unix socket stays, unauthenticated as before, so terminals on the server attach locally.

- **Authentication.** Every TCP request must carry `Authorization: Bearer <token>`. The token is read at start from the `tokenFile` the server was given (`run/server-token`, 0600, minted as `dsk_` plus 24 random bytes in base64url) and compared in constant time. A token holder acts as the operator peer, exactly like a socket client.
- **Refusal.** A missing or wrong token gets HTTP 401 before routing, in each route's own failure shape: `{"type": "server-response", "result": {"ok": false, "error": …}}` on `/api`, `{"ok": false, "error": …}` on `/dscode`, and a single `{"error": …}` line on `/stream`. The code is `dscode/unauthorized`. Refused requests do not count as activity.
- **No encryption.** The listener is plain HTTP. Confidentiality depends on the network (VPN, LAN, SSH tunnel).
- **Long-lived streams.** `requestTimeout` is disabled, because a stream's request body stays open for uplink items. TCP keepalive (30 s) is on at both ends, so an idle stream is not dropped by NAT. The client sends unary calls through a keep-alive agent and gives every stream its own unpooled connection.

A client names the server as `{url: "http://host:port", token}` instead of a socket path; `plugins/local-carrier/client.mjs` accepts either form everywhere (`requestOptions`, `targetFromEnv`).

### Routes

All requests are HTTP/1.1 over the socket. There are three routes:

| Route | Used for | Request body | Response body |
|---|---|---|---|
| `POST /api/<namespace>/<method>` | Typert unary calls | Typert envelope (JSON) | Typert envelope (JSON) |
| `POST /dscode/<name>` | DSCODE unary operations; `<name>` is URI-encoded (`host%2Fstatus`) | `{"args": {…}}` | `{"ok": true, "value": …}` or `{"ok": false, "error": {"code", "message"}}` |
| `POST /stream` | Every stream, Typert or DSCODE | NDJSON, see below | NDJSON, see below |

Any other path is handed to the upstream shared fetch handler under `/api`.

### Typert unary envelope

```json
→ {"type": "client-request", "rpcId": "<uuid>", "method": "session/create",
   "payload": {"args": {"request": {"cwd": "/work", "agentPreset": "dscode"}}}}
← {"type": "server-response", "rpcId": "<same uuid>",
   "result": {"ok": true, "value": {"sessionId": "…"}}}
```

`payload` always has a single `args` object whose keys are the method's parameter names; most session methods take one parameter called `request`. A failure is `{"ok": false, "error": {"code", "message"}}` inside `result`. A client must check that `rpcId` matches.

### DSCODE unary

The response is always HTTP 200; success and failure are distinguished by `ok`. A missing registry (a Harness without the `tui-host` plugin) answers `dscode/unavailable`; an unknown name answers `dscode/unknown-method`. Aborting the HTTP request aborts the operation's `signal`.

### Streams

One logical stream is one `POST /stream` exchange with `content-type: application/x-ndjson` in both directions.

- **Request**: the first line opens the stream, `{"endpoint": "<endpoint>", "payload": {"args": {…}}}`. Every later line is one uplink item, delivered to the stream in order. The client may keep the request body open for as long as it needs to send uplink items.
- **Response**: zero or more `{"item": …}` lines, then **exactly one** terminal line, `{"end": true}` or `{"error": {"code", "message"}}`. A response that closes without a terminal line is a broken stream.
- An endpoint starting with `dscode/` opens a DSCODE registry stream (`dscode/status/watch`); any other endpoint (`$events`, `session/follow`) opens a Typert stream through `typertGateway.wireStream`.
- Closing the connection, from either side, aborts the stream.

## Host lifecycle

| Operation | Form | Result |
|---|---|---|
| `host/status` | DSCODE unary | `{version, protocol, pid, startedAt, socketPath, clients, streams, sessions, running, idleExitMs, defaultCwd, tcp?}`; `defaultCwd` is the folder a remote client uses when it names none, `tcp` is `{port, bind}` on a server |
| `host/shutdown` | DSCODE unary | `{stopping: true}`; the Host exits about 50 ms later |

A launcher finds the Host by calling `host/status` with a 2-second timeout. If nothing answers, `ensureHost` (`scripts/host.mjs`) spawns `dscode host serve` detached, with output appended to `run/host.log` in the state directory, and polls `host/status` for up to 90 seconds. A started Host that exits early (it lost the lock race) is relaunched unless another Host has started answering. The launcher then starts the client with `DSCODE_RUNTIME_SOCKET` set to the socket path; the client refuses to start without it.

**Idle accounting.** `clients` counts open `$events` streams, one per attached client; `streams` counts all open streams. Every request except `host/status` refreshes the activity clock, so status probes never keep a Host alive. With `idleExitMs > 0` (default 600000, from `DSCODE_HOST_IDLE_MS`), the Host exits once `clients`, `streams` and running agents have all been zero for that long.

**Remote launch.** For a remote runtime (`dscode runtime <alias>`, or a default other than `local`), the launcher starts no local Host. It calls `host/status` over TCP and refuses to continue if the server does not answer, rejects the token, or speaks an incompatible protocol (see Versioning). It then starts the client with `DSCODE_RUNTIME_URL`, `DSCODE_RUNTIME_TOKEN`, `DSCODE_RUNTIME_CWD` (the session folder on the server: `--cwd`, else the alias's folder, else the server's `defaultCwd`) and `DSCODE_RUNTIME_ALIAS`. There is no fallback to this machine.

**Versioning.** Client and Host negotiate on a protocol version, `{major, minor}` in `plugins/local-carrier/protocol.mjs`, separate from the DSCODE release. `host/status` reports it as `protocol`. The same major is compatible. A newer minor only adds operations, optional arguments and fields: a client newer than its Host gets `dscode/unknown-method` for what the Host lacks, and an older client ignores what it does not know. A Host from DSCODE 0.7.48 or older reports no protocol and is matched only by its own release. `protocolCompatibility` makes the decision for the launcher and the terminal, and `protocol::compatibility` does so for the Rust client.

- **Remote.** The launcher checks the server before starting the terminal, and the terminal checks again after every reconnect.
- **Local.** `ensureHost` attaches to a compatible Host. It replaces one that is idle and incompatible or on an older minor, and refuses one that is incompatible and in use. Another installation sharing the state directory may have started it.

`protocol/versions.json` records the schema fingerprint of every protocol version, so `npm run test:unit` fails when the contract changes without a version bump. This includes a DSH upgrade that changes upstream types. `protocol/baseline.schema.json` is the first schema of the current major. `scripts/protocol-compat.mjs` reports what a later schema of that major would break for its clients: a removed operation or field, a newly required argument, a new value in an enum a client receives, or a changed type. A breaking change needs a major bump. After bumping, `node scripts/protocol-schema.mjs --record` records the new version, and a new major also resets the baseline.

Before protocol versions existed, client and Host had to run the same DSCODE release. `dscode update` still stops an idle Host before replacing the package and refuses while a client is attached.

## Client lifecycle

The sequence below is what `createTypertRuntime` (`packages/tui/src/runtime/typert.ts`) does. Another client should follow the same order.

### 1. Attach: the forwarded-event stream

Open stream `$events` with payload `{"args": {}}` and keep it open for the client's whole lifetime. Its first item is `{"type": "ready", "clientId": "…"}`; the client needs the `clientId` to answer anything. Later items:

| Item `type` | Meaning |
|---|---|
| `emit` | One-way event `{event, args}`. The terminal uses `api-session/status` (`[sessionId, running]`), `api-session/added` (`[{sessionId, agentAvailable, running}]`) and `api-session/removed` (`[sessionId]`). |
| `waterfall` | An interactive request that needs an answer: `{event, eventId, agentId, request}`. See [Approvals and questions](#4-approvals-and-questions). |
| `cancel` | `{eventId}`: the Host withdrew a pending waterfall, either because the turn ended or because another client answered it. |

This stream is also how the Host counts the client as attached.

### 2. Open a session

**New session.** Call Typert `session/create` with `{request: {sessionId?, cwd, agentPreset}}`. The terminal mints the `sessionId` itself; when it is omitted, the Host mints one and returns `{sessionId}`. `cwd` fixes the session's folder, and with it the folder's `AGENTS.md`/`CLAUDE.md`, ancestor skill roots and project hooks. Then, optionally:

- `session/selectModel` with `{request: {sessionId, provider, model, reasoningEffort?}}`.
- DSCODE `permissions/select` with `{sessionId, id}` for a permission preset chosen before the session existed.

**Resume.** No call is needed: opening `session/follow` on a persisted session makes the Host resume it. To turn user input (an id or an id prefix) into a session id, call DSCODE `sessions/resolveResume` with `{wanted, currentId?, allowLive: true}`. `allowLive: true` means "attach to the live session"; without it, a session that is live elsewhere is refused with `dscode/live-elsewhere` (the single-process rule). Subagent sessions are refused with `dscode/read-only`.

**Fork.** Typert `session/fork` with `{request: {sessionId, atSeq?}}` returns `{sessionId}` of the fork, which is then opened like a resume.

### 3. Follow the session

Open stream `session/follow`:

```json
{"endpoint": "session/follow", "payload": {"args": {"request": {
  "address": {"kind": "session", "sessionId": "…"},
  "assistantStream": true, "maxMessages": 1000}}}}
```

| Item `type` | Contents |
|---|---|
| `snapshot` | First item: `header`, `records` (`[{event}]`, the newest page, oldest first), `cursor` and `hasMore` |
| `event` | `event`: one committed session event, in sequence order |
| `assistant-stream` | `frame`: one live, uncommitted assistant presentation frame (text deltas and the like) |

**Older history.** While `hasMore` is true, call Typert `session/page` with `{request: {address, throughSeq: cursor, beforeSeq: <seq of the oldest event held>, maxMessages}}`. It returns `{records, hasMore}`; prepend the records. The terminal pages back to the start because it folds the whole log (transcript, fork points, history search).

**Running state.** Running state changes arrive as `turn/start` and `turn/end` events and as `api-session/status` emits. A client attaching mid-turn reads it once from Typert `session/list` (`{_request: {}}` returns `{items: [{sessionId, running, …}]}`), so it can show and interrupt the turn it joined.

**Child sessions.** Subagent and `/btw` sessions are not on the root's follow stream. Open DSCODE stream `sessions/children` with `{sessionId: <root>}`. Its items are `{kind: "event", sessionId, header, event}` for committed child events and `{kind: "stream", agentId, frame}` for live child frames. Only events from after the stream opened are delivered.

### 4. Approvals and questions

Agent-scoped interactive requests arrive on `$events` as `waterfall` items. The terminal handles two of them:

| `event` | `request` fields | Answer `value` |
|---|---|---|
| `approval/request` | `toolName`, `callId`, `reason`, `displayReason` | `"allowed-once"`, `"rejected"`, `"cancelled"` or `"unavailable"` |
| `user-questions/request` | the ask_user_question request (questions, options, plan review) | an `AskUserQuestionAnswer` |

The approval request does not carry the tool's arguments. Its `callId` matches the `tool/call` event on the follow stream, which does.

Answer through Typert unary `$events/result` with `{clientId, eventId, outcome}`, where `outcome` is one of:

- `{"kind": "result", "value": …}`: this client answers.
- `{"kind": "next"}`: this client declines and passes the request on. Use this for any `event` it does not handle and for agents it does not drive (the terminal treats the root `sessionId` as the `agentId` it drives).
- `{"kind": "rejected", "error": {"name", "message", "code?"}}`: answering failed.

A pending waterfall goes to **every** attached client and is replayed to a client that reconnects. The **first answer wins**. The others receive `cancel` for that `eventId` and must close their prompt without answering.

### 5. Drive the session

The terminal sends input and control through DSCODE operations, which carry DSCODE behaviour that upstream `session/prompt` does not:

| Operation | Args | Effect |
|---|---|---|
| `session/deliver` | `{sessionId, content, mode, context?}` | `content` is an array of content blocks; `mode` is `"followup"` (queue for the next turn, or start one) or `"steer"` (into the running turn). `context` is the model-facing user message that `mentions/prepare` produced for a session reference, injected ahead of the readable message. |
| `session/updateQueued` | `{sessionId, messageId, action}` | Change a queued next-turn message; `action` is `{kind: "edit", text}`, `{kind: "remove"}` or `{kind: "steer"}` (move it into the running turn) |
| `session/interrupt` | `{sessionId}` | Cancel the running turn but keep and re-wake the next-turn queue; returns `{cancelled, preserved}` |
| `commands/execute` | `{sessionId, line}` | Run a slash command line; returns `{handled}` |

Upstream `session/prompt` (`{request: {requestId, sessionId, mode: "queue" \| "steer", content}}`) and `session/cancel` also work on the Host, and `scripts/verify-local-carrier.mjs` exercises `session/prompt`. A minimal client may use them instead.

Operations on a session need a live agent on the Host; otherwise they fail with `dscode/session-not-live`. Following the session first makes it live.

### 6. Detach

Abort the follow, children and watch streams. The session stays on the Host, and a running turn continues. Close `$events` last; the Host then stops counting the client. Nothing has to be flushed, because the Host owns persistence.

### 7. Reconnect

A stream that fails with a connection error, or ends without being aborted, is reopened with backoff (250 ms, 500 ms, 1 s, 2 s, then every 5 s). A failure that carries a Remote or `dscode/*` code is the operation's own and is not retried.

- **`$events`.** A reopened stream gets a new `ready` with a new `clientId`. Prompts still open from the old connection are withdrawn, because the Host replays every waterfall that is still pending. An answer that could not be delivered is kept and sent when its `eventId` is replayed. The terminal shows the drop and the recovery as notices, and the session streams below retry at once instead of finishing their backoff.
- **`session/follow`.** The reopened stream opens with a fresh `snapshot`. The client keeps what it has folded, takes the snapshot's events newer than the last `seq` it saw, and pages back with `session/page` (`throughSeq` = the new `cursor`, `beforeSeq` = the oldest new record) until it reaches that `seq`. It then emits the missed events in order and re-reads the running state from `session/list`. Live assistant frames from the gap are not recovered; the committed message carries the text.
- **Watches and feeds** (`commands/watch`, `models/defaults`, `skills/watch`, `status/watch`, `notices/watch`, `sessions/children`, revision streams) reopen the same way. A revision stream's first item after a reopen counts as a change. Child events committed during the gap are not replayed.
- Unary calls made while disconnected fail and are reported. Opening a session or delivering a message is not retried automatically.

## Several clients on one session

- Every client follows the same session independently and sees the same committed events in the same order.
- Live `assistant-stream` frames are delivered only from the moment a client's follow stream opens. Text streamed before that appears once the assistant message is committed.
- One-way `emit` events are not replayed. State a reconnecting client needs must come from a query (`session/list`), the follow snapshot or a watch stream's opening value.
- Clients on the local socket and clients over TCP are equal. A remote and a local terminal can share one session on a server.
- Waterfalls follow the first-answer rule above.
- Input from every client goes into the session's one inbox; there is no per-client lock or ownership of a turn. Any client can interrupt a turn another client started.

## DSCODE operation catalog

Unary methods are `POST /dscode/<name>`; streams are endpoint `dscode/<name>`. Argument and result types live in the named source files under `packages/tui/src/host/`.

**Machine-readable contract.** `packages/tui/src/host/protocol.ts` lists every DSCODE operation with its wire types: `DscodeMethods` gives arguments and result, and `DscodeStreams` gives arguments, item and, for `authorization/begin`, uplink. It also lists the upstream Typert traffic a client depends on, with types taken from upstream:

- `TypertMethods`: `session/create`, `selectModel`, `fork`, `page`, `list`, `prompt`, `cancel` and `$events/result`.
- `TypertStreams`: `$events` and `session/follow`.
- `TypertWaterfalls`: the `approval/request` and `user-questions/request` payloads a client receives on `$events`, without the `agent` and `signal` the gateway strips, and the values it answers with.

Both sides are checked against the table by `npm run typecheck`. On the Host, every registration of a listed name must match its entry. In the terminal, `RuntimeClient.call` and `stream` take their argument and result types from the table, and so do the Typert calls in `runtime/typert.ts`. A caller that reads a field the contract does not have fails to compile. A method with nothing to report answers `null`. Upstream types the events on `session/follow` and `session/page` generically as `SessionWireEvent` (`type` plus JSON `data`) and leaves recognizing the extensible kinds to the reader, so a client reads them as `SessionEvent`.

`node scripts/protocol-schema.mjs` turns the table into JSON Schema at `protocol/dscode-runtime.schema.json`. `x-dscode-methods`, `x-dscode-streams`, `x-typert-methods`, `x-typert-streams` and `x-typert-waterfalls` map each wire name to its definitions. Three things in it go beyond a plain export of the TypeScript:

- **Upstream extensions.** Upstream packages add session event kinds and message sources to `SessionEventMap` and `MessageSourceMap` by declaration merging. The script loads every installed upstream declaration file that extends either map, so the schema lists the members those packages define (58 event kinds against DSH 0.2.0-rc.2).
- **Open unions.** `SessionEvent` and `MessageSource` are open, because plugins, some of them untyped JavaScript, add members at runtime. Each is a `oneOf`: a member of `SessionEventKnown` (or `MessageSourceKnown`), or an object whose `type` (or `kind`) is not a known value. A known kind with the wrong shape is invalid, not "other". A client must accept members it does not know. Each event's `data` is a named definition (`permission/preset` → `PermissionPresetEventData`).
- **Wire forms.** Upstream branded ids (`ReasoningEffortId`, `ToolCallId`, …) appear as their string or number. An `AbortSignal` inside an upstream type appears as the empty object it serializes to. A type name declared by two modules is qualified by its package (`DshAgentModelSelection`); other names stay bare. A result typed `unknown` comes from an untyped JavaScript module, such as `openrouter/account` and the `metrics` and `board` of `status/watch`. A union that admits nothing beyond its bare member collapses to it: `SessionSeq | -1` is `number`. Inline members of a union that also has named members are titled after their tag (`SessionFollowFrameSnapshot`).

`tests/protocol-schema.test.mjs` checks the committed file, so a stale schema fails `npm run test:unit`. `scripts/verify-protocol.mjs` checks the schema against a real Host; see [Verification](#verification). A client in another language generates its types from the schema; the Rust client in `clients/desktop` does so in its build script.

| Group | Methods | Streams | Source |
|---|---|---|---|
| Host | `host/status`, `host/shutdown` | | `plugins/local-carrier/index.mjs` |
| Delivery | `session/deliver`, `session/updateQueued`, `session/interrupt` | | `delivery.ts` |
| Commands | `commands/execute` | `commands/watch` `{sessionId?}` | `commands.ts` |
| Sessions | `sessions/list`, `sessions/subagents`, `sessions/delete`, `sessions/transcript`, `sessions/search`, `sessions/usage`, `sessions/rename`, `sessions/resolveResume` | | `sessions.ts` |
| Children and `/btw` | `btw/start` `{sessionId, childId, question, mode}`, `btw/dispose` `{ids}` | `sessions/children` `{sessionId}` | `children.ts` |
| Models | `models/directory`, `models/ensureRoute`, `models/save`, `models/compactionPreview`, `models/subagentOverride` | `models/defaults` | `models.ts` |
| Providers | `providers/directory`, `providers/saveCredential`, `providers/saveConfiguration`, `providers/discover`, `providers/unsetCredential`, `providers/remove` | `providers/watch` | `providers.ts` |
| Login | `authorization/directory`, `authorization/cancel`, `authorization/logout` | `authorization/watch`, `authorization/begin` | `providers.ts` |
| OpenRouter | `openrouter/managementKeyStatus`, `openrouter/saveManagementKey`, `openrouter/account` | | `providers.ts` |
| Custom providers | `custom/available`, `custom/list`, `custom/save`, `custom/remove`, `custom/discover`, `custom/test` | | `providers.ts` |
| Catalogs | `jobs/list`, `schedules/list`, `plugins/list`, `presets/planAvailable` | `skills/watch` `{sessionId?, cwd}` | `catalog.ts` |
| Permissions | `permissions/rows`, `permissions/names`, `permissions/effective`, `permissions/select` | | `catalog.ts` |
| Mentions | `mentions/candidates` `{sessionId?, cwd, query}`, `mentions/prepare` `{sessionId?, cwd, parsed}` | | `catalog.ts` |
| Attachments | `attachments/inspectImages`, `attachments/saveImages`, `attachments/inspectFiles`, `attachments/saveFiles` (paths the Host reads); `attachments/inspectImageData`, `attachments/saveImageData`, `attachments/inspectFileData`, `attachments/saveFileData` (content a remote client read) | | `catalog.ts` |
| Workspace | `workspace/gitDiff` `{cwd, argument}`, `workspace/commitDiff` `{cwd, sha}`, `workspace/mergeBase` `{cwd, branch}`, `workspace/reviewBranches`, `workspace/reviewCommits`, `workspace/gitBranch` `{cwd}`, `workspace/writeText` `{path, text}` | | `workspace.ts` |
| Footer and notices | | `status/watch` `{sessionId, modelLabel}`, `notices/watch` | `status.ts`, `notices.ts` |

**Content attachments.** A client that does not share the Host's filesystem (`RuntimeClient.sharesFilesystem` is false over TCP) sends a path it can read itself as content. The `…Data` inspect methods take `{items: [{path, name, bytes, signature}]}`, where `signature` is the base64 of the file's first 16 bytes. The save methods take `{items: [{name, data}]}` with the whole file in base64. Both apply the same count, size and format limits as the path methods. The client passes any path it cannot read to the path methods, and the Host resolves it in the session's folder. `workspace/*` always runs on the Host, so `/diff`, `/review`, `/export` and the status-line branch read the session's folder on that machine.

`models/subagentOverride` sets one Host-wide override shared by every client: `/subagent` in one terminal changes delegated agents' models for all sessions on that Host.

### Stream conventions

- **Value watches** (`commands/watch`, `models/defaults`, `skills/watch`) send the current value first, then a new value on every change, skipping values that serialize identically to the previous one.
- **Revision watches** (`providers/watch`, `authorization/watch`) send an increasing revision number; the client re-reads the matching `…/directory` method when it changes. The first item is the opening revision, not a change.
- **Samplers**: `status/watch` samples metrics, the service-speed label and the delegation board every 500 ms and sends only changes.
- **Event feeds** (`sessions/children`, `notices/watch`) send only what happens after they open.
- **Interactive login** (`authorization/begin` `{key, method}`) uses the uplink. The Host sends `{type: "notify", notice}`, `{type: "prompt", id, prompt}` and finally `{type: "done", status}`. The client answers each prompt by writing `{type: "answer", id, value}` or `{type: "decline", id}` as an uplink line. Secrets typed at a prompt cross the socket only as that uplink line.

## Errors

DSCODE failures carry a stable `code`; anything that is not a deliberate failure arrives as `dscode/internal` with the error message.

| Code | Meaning |
|---|---|
| `dscode/unauthorized` | A TCP request without the server's token |
| `dscode/unavailable` | The Host has no DSCODE registry mounted |
| `dscode/unknown-method`, `dscode/unknown-stream` | No such operation |
| `dscode/session-not-live` | The session has no live agent on this Host |
| `dscode/not-found`, `dscode/ambiguous`, `dscode/usage` | `sessions/resolveResume` could not resolve the input |
| `dscode/read-only` | A subagent session cannot be resumed as a root |
| `dscode/live-elsewhere` | The session is live and `allowLive` was not set |
| `dscode/*-unavailable` | The composition lacks the service (models, commands, schedule, permissions, custom providers, session query, `/btw`) |

Typert failures follow the upstream `RemoteFailure` codes. A stream's failure arrives as its terminal `{error}` line.

## A minimal client

`plugins/local-carrier/client.mjs` is a dependency-free Node client for the carrier: `call` (Typert unary), `callDscode`, `openStream` and `openDscodeStream`. The following script creates a session, prints the reply as it streams and rejects every approval:

```js
import { randomUUID } from 'node:crypto';
import { call, callDscode, openStream } from './plugins/local-carrier/client.mjs';

const socket = process.env.DSCODE_RUNTIME_SOCKET;
const value = result => { if (!result.ok) throw Error(result.error.message); return result.value; };

// 1. Attach.
let clientId;
void (async () => {
  for await (const frame of openStream(socket, '$events', { args: {} })) {
    if (frame.type === 'ready') clientId = frame.clientId;
    if (frame.type === 'waterfall') await call(socket, '$events/result', {
      clientId, eventId: frame.eventId,
      outcome: frame.event === 'approval/request' ? { kind: 'result', value: 'rejected' } : { kind: 'next' },
    });
  }
})();

// 2. Open.
const { sessionId } = value(await call(socket, 'session/create', { request: { cwd: process.cwd(), agentPreset: 'dscode' } }));

// 3. Follow, then 5. deliver.
void (async () => {
  const request = { address: { kind: 'session', sessionId }, assistantStream: true };
  for await (const frame of openStream(socket, 'session/follow', { args: { request } })) {
    const live = frame.type === 'assistant-stream' ? frame.frame : undefined;
    if (live?.type === 'chunk' && live.chunk.type === 'text-delta') process.stdout.write(live.chunk.text);
    if (frame.type === 'event' && frame.event.type === 'turn/end') process.exit(0);
  }
})();
await callDscode(socket, 'session/deliver', { sessionId, mode: 'followup', content: [{ type: 'text', text: 'hello' }] });
```

The socket path of a running Host is the `socketPath` field of `dscode host status`. For a remote server, pass `{ url: 'http://host:port', token }` wherever the example passes `socket`. Assistant frames are `@deepseek-ai/dsh-agent`'s `AssistantStreamFrame`: `start`, then `chunk` frames carrying an LLM `StreamChunk` (`text-delta`, `reasoning-delta`, `tool-call-delta`, …), then `end` with the committed event's `seq` or `abandoned`. Check them against the pinned DSH version.

## Verification

- `scripts/verify-local-carrier.mjs` drives a headless Host from a separate process with upstream methods only: create, select model, prompt, follow with live frames, and an approval rejected through `$events/result`.
- `scripts/verify-host.mjs` covers two clients on one session, a client killed mid-turn and reattached through paged history, concurrent Host starts, and idle exit.
- `scripts/verify-tui-runner.mjs` runs the real terminal in single-process, same-process protocol and separate-Host modes.
- `scripts/verify-remote.mjs` runs a real `dscode server` and a terminal with separate state directories: token refusal on every route, `dscode config`, the full terminal scenario over TCP, `/export` and the git branch in the server's folder, a server restart mid-session with the terminal reconnecting, content attachments, and refused launches.
- `scripts/verify-protocol.mjs` checks `protocol/dscode-runtime.schema.json` against a Host running the fixture model. It drives a plain turn, a turn with a rejected approval and a `/btw` child, through typed Typert calls. Every committed event, read back through `session/page` with small pages, and every child event must be a member of `SessionEventKnown`. The following must each match their definitions: every `$events` and `session/follow` frame, the approval payload and answer, the `sessions/children` items, the results of six Typert calls and 28 DSCODE methods, the first items of six watches, and the arguments the script sends.
- `tests/local-carrier.test.mjs` covers the envelopes, socket permissions, uplink, failure mapping, client abort, bearer-token checks on every TCP route and the version refusal. `tests/remote-runtime.test.mjs` covers the runtime configuration, the server token, content-attachment routing and limits, and stream reopening.

Not covered by an automated case: two clients answering the same waterfall at once, a waterfall answered across a reconnect, a client and server on different machines (the verifier uses loopback), and a long idle stream crossing real NAT.
