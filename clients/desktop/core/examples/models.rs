//! Every `models/*` operation through the generated, typed contract.
//!
//!     cargo run --example models -- --socket PATH
//!     cargo run --example models -- --url http://host:port --token TOKEN

use dscode_client_core::protocol::{ops, types};
use dscode_client_core::{Client, Error, Target};
use serde_json::json;
use std::collections::HashMap;
use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    let target = match (flag("--url"), flag("--socket")) {
        (Some(url), _) => Target::remote(&url, flag("--token").unwrap_or_default()),
        #[cfg(unix)]
        (None, Some(socket)) => Ok(Target::Socket(socket.into())),
        _ => {
            eprintln!("models: pass --socket PATH or --url URL --token TOKEN");
            return ExitCode::from(2);
        }
    };
    match target.and_then(run) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("models: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run(target: Target) -> Result<(), Error> {
    let client = Client::new(target);
    let none = types::NoArgs(HashMap::new());

    let directory = client.invoke::<ops::ModelsDirectory>(&none)?;
    for row in &directory.rows {
        println!("row {}/{} ({}) efforts={:?}", row.provider, row.model, row.model_name, row.reasoning.as_ref().map(|r| r.efforts.len()));
    }
    println!("failures={:?} reasoningFailures={:?}", directory.failures, directory.reasoning_failures);

    let defaults = client.watch::<ops::ModelsDefaults>(&none)?;
    let current = defaults.recv().ok_or_else(|| Error::Protocol("models/defaults ended without a value".into()))??;
    println!("default {}/{} effort={:?}", current.provider, current.model, current.reasoning_effort);
    defaults.stream().close();

    let route = client.invoke::<ops::ModelsEnsureRoute>(&types::ModelsEnsureRouteArgs { provider: current.provider.clone() })?;
    println!("ensureRoute changed={}", route.0);

    let first = directory.rows.first().cloned().ok_or_else(|| Error::Protocol("empty model directory".into()))?;
    let preview = client.invoke::<ops::ModelsCompactionPreview>(&types::ModelsCompactionPreviewArgs { session_id: "session-none".into(), row: first })?;
    println!("compactionPreview for an unknown session = {:?}", preview.0);

    client.invoke::<ops::ModelsSubagentOverride>(&types::ModelsSubagentOverrideArgs { selection: Some(current.clone()) })?;
    client.invoke::<ops::ModelsSubagentOverride>(&types::ModelsSubagentOverrideArgs { selection: None })?;
    println!("subagentOverride set and cleared");

    let saved = client.invoke::<ops::ModelsSave>(&types::ModelsSaveArgs { selection: current })?;
    println!("save saveError={:?} rejected={:?}", saved.save_error, saved.rejected);

    // A wrong shape is refused by the Rust types before it reaches the wire.
    let bad: Result<types::DshAgentModelSelection, _> = serde_json::from_value(json!({"provider": "fixture"}));
    println!("a selection without a model is rejected locally: {}", bad.is_err());
    println!("MODELS_TYPED_OK");
    Ok(())
}
