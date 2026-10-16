//! Headless chat against a running runtime, following the client lifecycle in
//! docs/runtime-protocol.md: attach `$events`, create a session, follow it,
//! deliver one message, stream the reply and answer approvals.
//!
//!     cargo run --example chat -- --socket PATH [--cwd DIR] [--model PROVIDER/MODEL]
//!         [--approve allow|reject] [--session-file FILE] MESSAGE...
//!     cargo run --example chat -- --url http://host:port --token TOKEN ... MESSAGE...
//!     cargo run --example chat -- --runtime NAME [--dscode PATH] ... MESSAGE...
//!
//! `--runtime` resolves a name from `runtimes.json` the way `dscode runtime NAME`
//! does; `local` attaches to or starts the Host through the launcher.

use dscode_client_core::{Client, Error, Launcher, Runtimes, StreamEvent, Target};
use serde_json::{json, Value};
use std::io::Write;
use std::process::ExitCode;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::{env, thread};

struct Options {
    target: Target,
    cwd: Option<String>,
    model: Option<(String, String)>,
    approve: bool,
    message: String,
}

fn parse() -> Result<Options, String> {
    let mut args = env::args().skip(1);
    let (mut socket, mut url, mut token, mut cwd, mut model, mut approve) = (None, None, String::new(), None, None, false);
    let (mut runtime, mut launcher) = (None, None::<String>);
    let mut message = Vec::new();
    while let Some(arg) = args.next() {
        let mut value = || args.next().ok_or_else(|| format!("{arg} needs a value"));
        match arg.as_str() {
            "--socket" => socket = Some(value()?),
            "--url" => url = Some(value()?),
            "--token" => token = value()?,
            "--cwd" => cwd = Some(value()?),
            "--model" => {
                let spec = value()?;
                let (provider, id) = spec.split_once('/').ok_or("--model takes PROVIDER/MODEL")?;
                model = Some((provider.to_owned(), id.to_owned()));
            }
            "--approve" => approve = value()? == "allow",
            "--runtime" => runtime = Some(value()?),
            "--dscode" => launcher = Some(value()?),
            _ => message.push(arg),
        }
    }
    let target = match (runtime, socket, url) {
        (Some(name), _, _) => {
            let launcher = Launcher::find(launcher.as_deref().map(std::path::Path::new)).map_err(|e| e.to_string())?;
            let runtimes = launcher.locate().and_then(|location| Runtimes::load(location.runtimes)).map_err(|e| e.to_string())?;
            let (target, folder) = runtimes.resolve(&name, Some(&launcher)).map_err(|e| e.to_string())?;
            cwd = cwd.or(folder);
            target
        }
        (None, _, Some(url)) => Target::remote(&url, token).map_err(|e| e.to_string())?,
        #[cfg(unix)]
        (None, Some(socket), None) => Target::Socket(socket.into()),
        _ => return Err("pass --runtime NAME, --socket PATH or --url URL --token TOKEN".into()),
    };
    if message.is_empty() {
        return Err("no message".into());
    }
    Ok(Options { target, cwd, model, approve, message: message.join(" ") })
}

fn main() -> ExitCode {
    let options = match parse() {
        Ok(options) => options,
        Err(error) => {
            eprintln!("chat: {error}");
            return ExitCode::from(2);
        }
    };
    match run(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("chat: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(options: Options) -> Result<(), Error> {
    let client = Client::new(options.target.clone());
    let status = client.host_status()?;
    if let Err(reason) = dscode_client_core::protocol::compatibility(&status, dscode_client_core::protocol::PROTOCOL) {
        return Err(Error::Protocol(format!("the runtime {reason}")));
    }
    eprintln!("[runtime {} · DSCODE {} · pid {}]", client.target(), status.version, status.pid);

    // 1. Attach. The first item names this client; approvals arrive later as waterfalls.
    let events = client.open_stream("$events", json!({}))?;
    let client_id = match events.recv() {
        Some(StreamEvent::Item(item)) if item["type"] == "ready" => item["clientId"].as_str().unwrap_or_default().to_owned(),
        other => return Err(Error::Protocol(format!("expected ready on $events, got {other:?}"))),
    };
    let approvals = Arc::new(AtomicUsize::new(0));
    {
        let (client, approvals, approve) = (client.clone(), approvals.clone(), options.approve);
        thread::spawn(move || {
            while let Some(StreamEvent::Item(item)) = events.recv() {
                if item["type"] != "waterfall" {
                    continue;
                }
                let outcome = if item["event"] == "approval/request" {
                    approvals.fetch_add(1, Ordering::SeqCst);
                    let decision = if approve { "allowed-once" } else { "rejected" };
                    eprintln!("\n[approval {} {} → {decision}]", item["request"]["toolName"], item["request"]["displayReason"]);
                    json!({"kind": "result", "value": decision})
                } else {
                    json!({"kind": "next"})
                };
                let answer = json!({"clientId": client_id, "eventId": item["eventId"], "outcome": outcome});
                if let Err(error) = client.call("$events/result", answer) {
                    eprintln!("[answer failed: {error}]");
                }
            }
        });
    }

    // 2. Open.
    let cwd = match options.cwd.or(status.default_cwd) {
        Some(cwd) => cwd,
        None => env::current_dir()?.display().to_string(),
    };
    let created = client.call("session/create", json!({"request": {"cwd": cwd, "agentPreset": "dscode"}}))?;
    let session_id = created["sessionId"].as_str().ok_or_else(|| Error::Protocol("session/create returned no sessionId".into()))?.to_owned();
    if let Some((provider, model)) = &options.model {
        client.call("session/selectModel", json!({"request": {"sessionId": session_id, "provider": provider, "model": model}}))?;
    }
    eprintln!("[session {session_id} in {cwd}]");

    // 3. Follow, then 5. deliver.
    let request = json!({"address": {"kind": "session", "sessionId": session_id}, "assistantStream": true, "maxMessages": 1000});
    let follow = client.open_stream("session/follow", json!({"request": request}))?;
    match follow.recv() {
        Some(StreamEvent::Item(item)) if item["type"] == "snapshot" => {}
        other => return Err(Error::Protocol(format!("expected snapshot on session/follow, got {other:?}"))),
    }
    client.call_dscode("session/deliver", json!({"sessionId": session_id, "mode": "followup", "content": [{"type": "text", "text": options.message}]}))?;

    let (mut deltas, mut tools) = (0usize, Vec::new());
    let mut out = std::io::stdout();
    loop {
        match follow.recv() {
            Some(StreamEvent::Item(item)) => match item["type"].as_str() {
                Some("assistant-stream") => {
                    let chunk = &item["frame"]["chunk"];
                    if item["frame"]["type"] == "chunk" && chunk["type"] == "text-delta" {
                        deltas += 1;
                        let _ = write!(out, "{}", chunk["text"].as_str().unwrap_or_default());
                        let _ = out.flush();
                    }
                }
                Some("event") => {
                    let event = &item["event"];
                    match event["type"].as_str() {
                        Some("tool/call") => tools.push(tool_name(event)),
                        Some("turn/end") => break,
                        _ => {}
                    }
                }
                _ => {}
            },
            Some(StreamEvent::End) | None => return Err(Error::Protocol("follow stream ended before turn/end".into())),
            Some(StreamEvent::Failed(error)) => return Err(error),
        }
    }
    println!();
    let report = json!({"sessionId": session_id, "liveTextDeltas": deltas, "tools": tools, "approvals": approvals.load(Ordering::SeqCst)});
    println!("CORE_CHAT_DONE {report}");
    Ok(())
}

fn tool_name(event: &Value) -> String {
    let data = &event["data"];
    [&data["toolName"], &data["name"], &data["message"]["toolName"], &data["call"]["name"]]
        .iter()
        .find_map(|v| v.as_str())
        .unwrap_or("?")
        .to_owned()
}
