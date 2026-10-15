# DSCODE desktop client (spike)

> **Status: spike, not shipped.** A native client written in Rust with [GPUI](https://gpui.rs) through [GPUI Kit](https://gpui-kit.com). It is not built, packaged or released by `make release`; the release scripts copy an explicit list of directories that does not include `clients/`.

It speaks the protocol in [Client and runtime protocol](../../docs/runtime-protocol.md), over the local Host's Unix socket or a `dscode server` TCP listener with its token.

| Crate | What it is |
|---|---|
| `core` (`dscode-client-core`) | UI-free client: carrier transport (HTTP/1.1 over Unix socket or TCP, chunked NDJSON streams with uplink), Typert unary calls, DSCODE operations, `host/status`. Blocking I/O, one thread per stream, items delivered on `flume` channels that work from blocking and async code. `build.rs` generates `protocol::types` and one `protocol::ops` marker per operation from [`protocol/dscode-runtime.schema.json`](../../protocol/dscode-runtime.schema.json); `Client::invoke::<ops::ModelsSave>(&args)` and `Client::watch::<ops::ModelsDefaults>(&args)` are typed end to end. |
| `app` (`dscode-desktop`) | GPUI window: connects, creates a session, streams the reply as Markdown, shows tool calls and results, and answers approvals. |

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
cargo run -p dscode-desktop -- --socket SOCKET                        # the window
```

Fixture prompts: `APPROVE` asks to write outside the workspace (an approval), `ASK` asks a question, `SLOW` streams slowly.

## What the spike checked (2026-10-14, macOS 26.6, Apple Silicon)

- `chat` example over the socket and over TCP: live text deltas, an approval rejected through `$events/result`, and a wrong token refused as `dscode/unauthorized`.
- The window against the fixture Host: two turns streamed, `APPROVE 写一个文件` delivered and shown with CJK text intact, two approval requests rejected (one through the accessibility press action, one by mouse), the rejected tool results and the final reply rendered, and Stop/Send following the running state.
- `cargo test`: transport framing (chunked decoding, request heads, token only on TCP), address parsing, result unwrapping, and the transcript fold.

## Known gaps and findings

- **Redraw while hidden.** With the window behind another window, state kept updating but no new frame (and no new accessibility tree) was presented until the window came to the front. Whether a visible but unfocused window redraws is not yet checked.
- **Input methods.** Text was entered with synthesized key events, not through a real input method; Pinyin composition on macOS and fcitx/ibus on Linux remain untested.
- **Not implemented yet:** choosing a server and the default local Host (needs the launcher's `ensureHost`), resuming sessions and paging history, reconnecting, subagent and `/btw` feeds, slash commands, questions (`user-questions/request`), attachments, model selection, and every other DSCODE operation.
- **Protocol definition.** All DSCODE operations and session events come from the shared contract ([Client and runtime protocol](../../docs/runtime-protocol.md#dscode-operation-catalog)); `types::SessionEvent` is open (`SessionEventKnown` or an unknown member). The window itself still reads events as JSON and has not moved to the generated types. Typert calls (`session/create`, `session/follow`, `$events`) are not in the schema yet, and a protocol version to replace the exact-release check does not exist yet.
- **typify workarounds** (`core/build.rs`): `const` is rewritten as a one-value `enum`, since typify keeps a `const` as a plain string and an untagged union of blocks would then misread one block kind as another.
- Linux and Windows builds have not been attempted.
