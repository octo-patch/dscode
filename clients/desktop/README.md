# DSCODE desktop client (spike)

> **Status: spike, not shipped.** A native client written in Rust with [GPUI](https://gpui.rs) through [GPUI Kit](https://gpui-kit.com). It is not built, packaged or released by `make release`; the release scripts copy an explicit list of directories that does not include `clients/`.

It speaks the protocol in [Client and runtime protocol](../../docs/runtime-protocol.md), over the local Host's Unix socket or a `dscode server` TCP listener with its token.

| Crate | What it is |
|---|---|
| `core` (`dscode-client-core`) | UI-free client: carrier transport (HTTP/1.1 over Unix socket or TCP, chunked NDJSON streams with uplink), Typert unary calls, DSCODE operations, `host/status`. `runtimes` reads and writes the `runtimes.json` the terminal's `dscode config` uses (owner-only, atomic, unknown fields kept); `launcher` finds `dscode` (`--dscode`, `$DSCODE_CLI`, PATH, `~/.local/bin`, Homebrew) and asks it for the local Host with `dscode host locate` and `dscode host start --json`, so the attach/replace/refuse decision stays in `ensureHost`. Blocking I/O, one thread per stream, items delivered on `flume` channels that work from blocking and async code. `build.rs` generates `protocol::types` and one `protocol::ops` marker per operation from [`protocol/dscode-runtime.schema.json`](../../protocol/dscode-runtime.schema.json); `Client::invoke::<ops::ModelsSave>(&args)` and `Client::watch::<ops::ModelsDefaults>(&args)` are typed end to end. |
| `app` (`dscode-desktop`) | GPUI window with a sidebar (runtime switcher, "New session", the runtime's root sessions grouped by last activity, a dot on running ones) and a centered conversation (user bubbles, Markdown replies, tool calls as cards with a running/done/failed state, an approval card, a composer card with folder and model menus and a send/stop button); it follows the system light or dark appearance. It connects to the default runtime (or `--runtime NAME`, `--socket`, `--url`); one connection serves every session, and picking one in the sidebar follows it (the Host resumes it). A new session is a draft until its first message, so opening the window leaves no empty sessions; `--session ID` opens an existing one. The folder menu (drafts only) offers recent folders, the runtime's default and, for a runtime on this machine, the system folder dialog. The model menu lists `models/directory` by provider; a pick goes through `models/ensureRoute`, `session/selectModel` for the open session and `models/save`, as the terminal's /model does. A session opens with its last 200 messages and "Load earlier messages" pages back with `session/page` (`DSCODE_DESKTOP_PAGE_MESSAGES` lowers the page size for testing). When an established connection drops, the window retries after 1, 2, 4… up to 15 seconds, through the launcher for `local` (which starts a Host again), and reopens the session it showed. It streams the reply as Markdown, shows tool calls and results, and answers approvals. Everything it sends and reads goes through the generated types: `$events` frames and typed approval answers, `session/create` and `session/follow`, `session/deliver` and `session/interrupt`, and session events as `SessionEventKnown` variants. An event kind it does not know is skipped; a known kind that does not decode is logged to stderr and skipped. The runtime button in the header lists `local` and every configured server, adds a server, forgets one and sets the default, all in the shared `runtimes.json`. Switching closes the old `$events` and follow streams and drops their late events by connection generation. A lost connection offers Reconnect, which opens a new session. |

## Run it

Rust comes from the rustup `stable` toolchain (1.99 at the time of the spike). The first build compiles GPUI and takes several minutes; `target/` is about 3 GB.

```bash
# A throwaway Host with the deterministic fixture model; prints FIXTURE_HOST {socket, url, token, workspace}.
node clients/desktop/scripts/fixture-host.mjs --port 47811

cd clients/desktop
cargo test
cargo run --example chat -- --socket SOCKET hello                     # headless, over the socket
cargo run --example chat -- --url http://127.0.0.1:47811 --token TOKEN APPROVE writing a file
cargo run --example models -- --socket SOCKET                         # every models/* operation, typed
cargo run --example conformance -- --socket SOCKET                    # live events and results against the generated types
cargo run -p dscode-desktop -- --socket SOCKET                        # the window, on one address

# Through the launcher, as an installed app would: the runtimes of the fixture's state directory.
DSCODE_SOURCE_HOME=HOME cargo run -p dscode-desktop -- --dscode ../../bin/dscode.mjs [--runtime NAME]
DSCODE_SOURCE_HOME=HOME cargo run --example chat -- --dscode ../../bin/dscode.mjs --runtime local hello
```

`HOME` is the `home` the fixture prints. An installed `dscode` from before `host locate` is reported as too old; point `--dscode` at this checkout's `bin/dscode.mjs`.

Fixture prompts: `APPROVE` asks to write outside the workspace (an approval), `ASK` asks a question, `SLOW` streams slowly.

## What the spike checked (2026-10-14, macOS 26.6, Apple Silicon)

- `chat` example over the socket and over TCP: live text deltas, an approval rejected through `$events/result`, and a wrong token refused as `dscode/unauthorized`.
- The window against the fixture Host: two turns streamed, `APPROVE 写一个文件` delivered and shown with CJK text intact, two approval requests rejected (one through the accessibility press action, one by mouse), the rejected tool results and the final reply rendered, and Stop/Send following the running state.
- The window on the generated types (2026-10-15), against a fixture Host: a reply streamed, `APPROVE 写一个文件` raised an approval that arrived as a typed `ApprovalRequestPayload` with its Chinese reason, and a typed `Rejected` answer produced the rejected tool result and the final reply. Nothing failed to decode (stderr stayed empty).
- Runtime choice (2026-10-15), against a fixture Host with a TCP listener: `chat --runtime local` attached through the launcher (under a second) and, with no Host running in a fresh state directory, started one (about 23 s) that exited when idle afterwards; `--runtime fix` reached the TCP listener from `runtimes.json`, a wrong token was reported as refused and an unknown name as unknown. The window with no flags attached to `local`; its runtime menu opened (accessibility tree and screenshot) with `local (default)` and "Add a server…", and the add-server dialog rendered. The window with `--runtime fix` connected over TCP (the Host counted one client after earlier windows were killed), and with `--runtime bad` it showed the refusal and Reconnect.
- The sidebar layout (2026-10-15, dark appearance, fixture Host): `--session` resumed a session with its user message, failed `write` card and reply; a plain launch showed the empty draft and created no session; a prompt delivered from outside showed the running dot, the header's "Working", the spinning `write` card, the approval card with its Chinese reason and Stop; "Allow once" (accessibility press) finished the turn with a checked card and the reply, and the list moved the session to the top.
- Paging and reconnect (2026-10-15, a launcher-managed Host in an isolated state directory with the fixture model): with a page size of 2, `--session` opened a five-turn session showing only the last turn, and two presses of "Load earlier messages" prepended the earlier turns above it. `dscode host stop` under the open window: its retry went through the launcher, a new Host started, and the window attached again (`host status`: one client, one session) with the same session reloaded.
- `cargo test`: transport framing (chunked decoding, request heads, token only on TCP), address parsing, result unwrapping, and the transcript fold.

## Known gaps and findings

- **Redraw while hidden.** With the window behind another window, state kept updating but no new frame (and no new accessibility tree) was presented until the window came to the front. Whether a visible but unfocused window redraws is not yet checked.
- **Input methods.** Text was entered with synthesized key events, not through a real input method; Pinyin composition on macOS and fcitx/ibus on Linux remain untested.
- **Not checked by hand yet:** picking another runtime from the menu and submitting the add-server dialog. Driving them failed because the window kept losing focus to other apps during automation (synthesized typing landed in the wrong field). Their file edits are the unit-tested `Runtimes::set_remote/remove/set_default/save`, and switching runs the same `connect` as startup.
- **Not checked by hand yet:** the folder and model menus. Their triggers carry accessibility labels, but a gpui-kit dropdown trigger exposes no press action (so VoiceOver cannot open these menus either), and pixel clicks did not open them while other apps held focus. Switching models was not exercised (the fixture offers one model).
- **Not checked by hand yet (layout):** sending the first message of a draft from the composer (synthesized keys went through the active Pinyin input method and arrived as marked text) and the light appearance.
- **Not implemented yet:** reasoning effort in the model menu, the session's own model after resume (the menu shows the deployment default or the last pick), renaming and deleting sessions, subagent and `/btw` feeds, slash commands, questions (`user-questions/request`), attachments, model selection, and every other DSCODE operation.
- **Protocol definition.** All DSCODE operations and session events come from the shared contract ([Client and runtime protocol](../../docs/runtime-protocol.md#dscode-operation-catalog)); `types::SessionEvent` is open (`SessionEventKnown` or an unknown member). Typert calls, `$events`, `session/follow` and the approval and question waterfalls are in the schema too (`Client::typert::<typert::SessionCreate>`, `typert_stream::<typert::SessionFollow>`, the `Waterfall` trait); follow events arrive as upstream's generic `SessionWireEvent`, and `.known()` reads one as a `SessionEvent`. On connect the client checks `host/status.protocol` against the schema's `PROTOCOL` (`protocol::compatibility`): the same major works, and a Host from before protocol negotiation is refused.
- **typify workarounds** (`core/build.rs`): `const` is rewritten as a one-value `enum`, since typify keeps a `const` as a plain string and an untagged union of blocks would then misread one block kind as another; the "other" member of an open union gets `additionalProperties: {}` so its fields are kept.
- Linux and Windows builds have not been attempted.
