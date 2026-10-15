//! Checks the generated contract against a live runtime: drives a session with
//! a tool call and a rejected approval, decodes every committed event as
//! `SessionEvent`, and calls the read-only operations through their generated
//! types. Prints one line per check and exits non-zero on any mismatch.
//!
//!     cargo run --example conformance -- --socket PATH   (a fixture Host)

use dscode_client_core::protocol::{ops, typert, types, Method, Waterfall, Watch};
use dscode_client_core::{Client, Error, Target};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::process::ExitCode;
use std::time::{Duration, Instant};
use std::{env, thread};

struct Report {
    failures: usize,
}

impl Report {
    fn check<T>(&mut self, label: &str, result: Result<T, Error>, show: impl FnOnce(&T) -> String) -> Option<T> {
        match result {
            Ok(value) => {
                println!("ok    {label}: {}", show(&value));
                Some(value)
            }
            Err(error) => {
                self.failures += 1;
                println!("FAIL  {label}: {error}");
                None
            }
        }
    }
}

fn none() -> types::NoArgs {
    types::NoArgs(Default::default())
}

fn invoke<M: Method>(client: &Client, args: M::Args) -> Result<M::Result, Error> {
    client.invoke::<M>(&args)
}

/// The first item of a value watch.
fn first<W: Watch>(client: &Client, args: W::Args) -> Result<W::Item, Error> {
    let stream = client.watch::<W>(&args)?;
    let item = stream.recv().ok_or_else(|| Error::Protocol(format!("{} ended without a value", W::NAME)))?;
    stream.stream().close();
    item
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let Some(socket) = args.iter().position(|a| a == "--socket").and_then(|i| args.get(i + 1)) else {
        eprintln!("conformance: pass --socket PATH");
        return ExitCode::from(2);
    };
    #[cfg(unix)]
    let client = Client::new(Target::Socket(socket.into()));
    #[cfg(not(unix))]
    let client: Client = unimplemented!("{socket}");
    let mut report = Report { failures: 0 };
    if let Err(error) = run(&client, &mut report) {
        report.failures += 1;
        println!("FAIL  setup: {error}");
    }
    println!("{} failure(s)", report.failures);
    if report.failures == 0 { ExitCode::SUCCESS } else { ExitCode::FAILURE }
}

fn run(client: &Client, report: &mut Report) -> Result<(), Error> {
    let status = report.check("host/status", invoke::<ops::HostStatus>(client, none()), |s| format!("DSCODE {} pid {}", s.version, s.pid));
    let cwd = status.map(|s| s.default_cwd).unwrap_or_default();

    // Attach through the typed `$events` stream; reject every approval with a typed answer.
    let events = client.typert_stream::<typert::Events>(&none())?;
    let client_id = match events.recv() {
        Some(Ok(types::RemoteEventDownlinkFrame::ReadyFrame(ready))) => ready.client_id,
        other => return Err(Error::Protocol(format!("no ready on $events: {other:?}"))),
    };
    let frame_failures = Arc::new(AtomicUsize::new(0));
    let approvals = Arc::new(AtomicUsize::new(0));
    {
        let (client, frame_failures, approvals) = (client.clone(), frame_failures.clone(), approvals.clone());
        thread::spawn(move || {
            while let Some(frame) = events.recv() {
                let invocation = match frame {
                    Ok(types::RemoteEventDownlinkFrame::InvocationFrame(invocation)) => invocation,
                    Ok(_) => continue,
                    Err(error) => {
                        frame_failures.fetch_add(1, Ordering::SeqCst);
                        println!("FAIL  $events frame: {error}");
                        continue;
                    }
                };
                let outcome = if invocation.event == typert::ApprovalRequest::EVENT {
                    match serde_json::from_value::<<typert::ApprovalRequest as Waterfall>::Payload>(Value::Object(invocation.request.clone())) {
                        Ok(payload) => println!("ok    approval/request payload: {} {:?}", payload.tool_name, payload.call_id),
                        Err(error) => {
                            frame_failures.fetch_add(1, Ordering::SeqCst);
                            println!("FAIL  approval/request payload: {error}");
                        }
                    }
                    approvals.fetch_add(1, Ordering::SeqCst);
                    json!({"kind": "result", "value": types::ApprovalOutcome::Rejected})
                } else {
                    json!({"kind": "next"})
                };
                let answer = serde_json::from_value(json!({"clientId": client_id, "eventId": invocation.event_id, "outcome": outcome})).expect("a valid answer");
                if let Err(error) = client.typert::<typert::EventsResult>(&answer) {
                    frame_failures.fetch_add(1, Ordering::SeqCst);
                    println!("FAIL  $events/result: {error}");
                }
            }
        });
    }
    let request = types::SessionCreateRequest { agent_preset: Some("dscode".into()), cwd: Some(cwd.clone()), session_id: None, workspace_id: None };
    let created = report.check("session/create", client.typert::<typert::SessionCreate>(&types::SessionCreateArgs { request }), |c| c.session_id.clone());
    let session_id = created.ok_or_else(|| Error::Protocol("no session".into()))?.session_id;
    let follow_args = |max: u32| -> types::SessionFollowArgs {
        serde_json::from_value(json!({"request": {"address": {"kind": "session", "sessionId": session_id}, "assistantStream": true, "maxMessages": max}})).expect("valid follow arguments")
    };
    let follow = client.typert_stream::<typert::SessionFollow>(&follow_args(1000))?;

    // Two turns through the typed delivery operation: plain text, then a tool call that needs approval.
    let (mut live_frames, mut follow_events) = (0usize, 0usize);
    for text in ["hello", "APPROVE writing a file"] {
        let message: types::SessionDeliverArgs = serde_json::from_value(json!({"sessionId": session_id, "mode": "followup", "content": [{"type": "text", "text": text}]}))
            .map_err(|e| Error::Protocol(e.to_string()))?;
        report.check(&format!("session/deliver {text:?}"), invoke::<ops::SessionDeliver>(client, message), |_| "null".into());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if Instant::now() > deadline {
                return Err(Error::Protocol("turn did not end".into()));
            }
            match follow.recv() {
                Some(Ok(types::SessionFollowFrame::EventEntry(entry))) => {
                    follow_events += 1;
                    if matches!(entry.event.known(), Ok(types::SessionEvent::Known(types::SessionEventKnown::TurnEnd { .. }))) {
                        break;
                    }
                }
                Some(Ok(types::SessionFollowFrame::FollowFrameAssistantStream { .. })) => live_frames += 1,
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    report.failures += 1;
                    println!("FAIL  session/follow frame: {error}");
                }
                None => return Err(Error::Protocol("follow stopped".into())),
            }
        }
    }
    follow.stream().close();
    println!("ok    session/follow: {follow_events} events and {live_frames} live assistant frames decoded");

    // Every committed event, re-read from a fresh snapshot, must decode as a known SessionEvent member.
    let follow = client.typert_stream::<typert::SessionFollow>(&follow_args(1000))?;
    let records = match follow.recv() {
        Some(Ok(types::SessionFollowFrame::FollowFrameSnapshot { records, .. })) => records,
        other => return Err(Error::Protocol(format!("no snapshot: {other:?}"))),
    };
    follow.stream().close();
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    for record in &records {
        let event = &record.event;
        match event.known() {
            Ok(types::SessionEvent::Known(_)) => *kinds.entry(event.type_.clone()).or_default() += 1,
            Ok(types::SessionEvent::Other { .. }) => {
                report.failures += 1;
                println!("FAIL  SessionEventKnown {} (seq {}): not a known member\n      {}", event.type_, event.seq, truncate(&serde_json::to_string(event).unwrap_or_default(), 600));
            }
            Err(error) => {
                report.failures += 1;
                println!("FAIL  SessionEvent {} (seq {}): {error}", event.type_, event.seq);
            }
        }
    }
    println!("ok    {} committed events decoded: {kinds:?}", kinds.values().sum::<usize>());
    report.check("session/list", client.typert::<typert::SessionList>(&serde_json::from_value(json!({"_request": {}})).unwrap()), |l| format!("{} sessions", l.items.len()));
    report.check("session/fork", client.typert::<typert::SessionFork>(&serde_json::from_value(json!({"request": {"sessionId": session_id}})).unwrap()), |f| f.session_id.clone());
    report.failures += frame_failures.load(Ordering::SeqCst);
    if approvals.load(Ordering::SeqCst) == 0 {
        report.failures += 1;
        println!("FAIL  no approval/request arrived");
    }

    let some = Some(session_id.clone());
    report.check("sessions/list", invoke::<ops::SessionsList>(client, serde_json::from_value(json!({"options": {"sessions": "all", "cwd": "all", "sort": "newest", "currentCwd": cwd, "query": ""}})).unwrap()), |rows| format!("{} rows", rows.len()));
    report.check("sessions/usage", invoke::<ops::SessionsUsage>(client, types::SessionsUsageArgs { session_id: some.clone() }), |u| format!("{} turns", u.turns.len()));
    report.check("sessions/transcript", invoke::<ops::SessionsTranscript>(client, types::SessionsTranscriptArgs { id: session_id.clone() }), |t| format!("{} chars", t.len()));
    report.check("sessions/search", invoke::<ops::SessionsSearch>(client, types::SessionsSearchArgs { query: "hello".into() }), |rows| format!("{} hits", rows.len()));
    report.check("sessions/subagents", invoke::<ops::SessionsSubagents>(client, types::SessionsSubagentsArgs { session_id: session_id.clone(), cwd: cwd.clone() }), |rows| format!("{} rows", rows.len()));
    report.check("sessions/resolveResume", invoke::<ops::SessionsResolveResume>(client, types::SessionsResolveResumeArgs { wanted: session_id.clone(), current_id: None, allow_live: Some(true) }), |id| id.0.clone());
    report.check("jobs/list", invoke::<ops::JobsList>(client, types::JobsListArgs { session_id: some.clone() }), |rows| format!("{} jobs", rows.len()));
    report.check("schedules/list", invoke::<ops::SchedulesList>(client, types::SchedulesListArgs { session_id: session_id.clone() }), |rows| format!("{} rows", rows.len()));
    report.check("plugins/list", invoke::<ops::PluginsList>(client, none()), |rows| format!("{} plugins", rows.len()));
    report.check("presets/planAvailable", invoke::<ops::PresetsPlanAvailable>(client, none()), |v| format!("{v:?}"));
    report.check("permissions/rows", invoke::<ops::PermissionsRows>(client, none()), |rows| format!("{} presets", rows.len()));
    report.check("permissions/names", invoke::<ops::PermissionsNames>(client, none()), |names| names.join(","));
    report.check("permissions/effective", invoke::<ops::PermissionsEffective>(client, types::PermissionsEffectiveArgs { session_id: some.clone(), pending: None }), |p| p.0.clone());
    report.check("mentions/candidates", invoke::<ops::MentionsCandidates>(client, types::MentionsCandidatesArgs { session_id: some.clone(), cwd: cwd.clone(), query: "".into() }), |rows| format!("{} candidates", rows.len()));
    report.check("providers/directory", invoke::<ops::ProvidersDirectory>(client, none()), |_| "decoded".into());
    report.check("authorization/directory", invoke::<ops::AuthorizationDirectory>(client, none()), |d| format!("{} rows", d.rows.len()));
    report.check("openrouter/managementKeyStatus", invoke::<ops::OpenrouterManagementKeyStatus>(client, none()), |s| format!("{:?}", s.state));
    report.check("custom/available", invoke::<ops::CustomAvailable>(client, none()), |v| format!("{v:?}"));
    report.check("custom/list", invoke::<ops::CustomList>(client, none()), |s| format!("{} providers rev {:?}", s.providers.len(), s.revision));
    report.check("workspace/gitBranch", invoke::<ops::WorkspaceGitBranch>(client, types::WorkspaceGitBranchArgs { cwd: cwd.clone() }), |b| format!("{b:?}"));
    report.check("commands/watch", first::<ops::CommandsWatch>(client, types::CommandsWatchArgs { session_id: some.clone() }), |c| format!("{} commands", c.descriptors.len()));
    report.check("skills/watch", first::<ops::SkillsWatch>(client, types::SkillsWatchArgs { session_id: some.clone(), cwd: cwd.clone() }), |s| format!("{} skills", s.rows.len()));
    report.check("status/watch", first::<ops::StatusWatch>(client, types::StatusWatchArgs { session_id: session_id.clone(), model_label: "fixture/fixture".into() }), |s| format!("speed {:?}", s.speed));
    report.check("providers/watch", first::<ops::ProvidersWatch>(client, none()), |r| format!("revision {r}"));
    report.check("models/defaults", first::<ops::ModelsDefaults>(client, none()), |m| format!("{}/{}", m.provider, m.model));
    Ok(())
}

fn truncate(text: &str, max: usize) -> &str {
    text.char_indices().nth(max).map_or(text, |(i, _)| &text[..i])
}
