//! Generate the DSCODE operation types from the protocol schema, which
//! `scripts/protocol-schema.mjs` derives from the TypeScript wire contract
//! (`packages/tui/src/host/protocol.ts`). Output: `$OUT_DIR/protocol.rs`.

use serde_json::Value;
use std::fmt::Write as _;
use std::path::Path;
use std::{env, fs};

const SCHEMA: &str = "../../../protocol/dscode-runtime.schema.json";

fn main() {
    println!("cargo:rerun-if-changed={SCHEMA}");
    let text = fs::read_to_string(SCHEMA).unwrap_or_else(|error| panic!("read {SCHEMA}: {error}"));
    let raw: Value = serde_json::from_str(&text).expect("the protocol schema is JSON");

    let mut settings = typify::TypeSpaceSettings::default();
    settings.with_struct_builder(false);
    let mut types = typify::TypeSpace::new(&settings);
    // Only the definitions become types; without a title the root itself does not.
    let mut definitions = raw.clone();
    const_to_enum(&mut definitions);
    definitions.as_object_mut().unwrap().retain(|key, _| key == "definitions" || key == "$schema");
    types.add_root_schema(serde_json::from_value(definitions).expect("the protocol schema is a JSON Schema")).expect("typify accepts the protocol schema");
    let file: syn::File = syn::parse2(types.to_stream()).expect("typify emits Rust");

    let mut out = String::from("/// Types of the DSCODE operations' arguments, results and stream items.\npub mod types {\n    #![allow(clippy::all, unused_imports, irrefutable_let_patterns)]\n");
    out.push_str(&prettyplease::unparse(&file));
    let version = &raw["x-protocol-version"];
    writeln!(
        out,
        "}}\n\n/// The protocol version this client was generated for.\npub const PROTOCOL: Protocol = Protocol {{ major: {}, minor: {} }};\n",
        version["major"].as_u64().expect("x-protocol-version.major"),
        version["minor"].as_u64().expect("x-protocol-version.minor")
    )
    .unwrap();
    out.push_str("/// One marker per operation, binding its wire name to its types.\npub mod ops {\n    use super::{types, Method, Uplink, Watch};\n");
    for (table, item, trait_name) in [("x-dscode-methods", "result", "Method"), ("x-dscode-streams", "item", "Watch")] {
        let operations = raw[table].as_object().unwrap_or_else(|| panic!("{table} missing"));
        for (name, operation) in operations {
            let marker = pascal(name);
            let ty = |part: &str| format!("types::{}", operation[part].as_str().unwrap_or_else(|| panic!("{name}.{part}")));
            if let Some(doc) = operation["description"].as_str() {
                writeln!(out, "    #[doc = {doc:?}]").unwrap();
            }
            writeln!(out, "    pub struct {marker};").unwrap();
            let associated = if trait_name == "Method" { "Result" } else { "Item" };
            writeln!(
                out,
                "    impl {trait_name} for {marker} {{ const NAME: &'static str = {name:?}; type Args = {}; type {associated} = {}; }}",
                ty("args"),
                ty(item)
            )
            .unwrap();
            if let Some(uplink) = operation["uplink"].as_str() {
                writeln!(out, "    impl Uplink for {marker} {{ type Uplink = types::{uplink}; }}").unwrap();
            }
        }
    }
    out.push_str("}\n\n/// One marker per upstream Typert call, stream and answered waterfall.\npub mod typert {\n    use super::{types, TypertMethod, TypertStream, Waterfall};\n");
    for (table, item, trait_name, associated) in [
        ("x-typert-methods", "result", "TypertMethod", "Result"),
        ("x-typert-streams", "item", "TypertStream", "Item"),
    ] {
        for (name, operation) in raw[table].as_object().unwrap_or_else(|| panic!("{table} missing")) {
            let marker = pascal(name);
            if let Some(doc) = operation["description"].as_str() {
                writeln!(out, "    #[doc = {doc:?}]").unwrap();
            }
            writeln!(out, "    pub struct {marker};").unwrap();
            writeln!(
                out,
                "    impl {trait_name} for {marker} {{ const NAME: &'static str = {name:?}; type Args = types::{}; type {associated} = types::{}; }}",
                operation["args"].as_str().unwrap(),
                operation[item].as_str().unwrap()
            )
            .unwrap();
        }
    }
    for (event, waterfall) in raw["x-typert-waterfalls"].as_object().expect("x-typert-waterfalls missing") {
        let marker = pascal(event);
        writeln!(out, "    pub struct {marker};").unwrap();
        writeln!(
            out,
            "    impl Waterfall for {marker} {{ const EVENT: &'static str = {event:?}; type Payload = types::{}; type Answer = types::{}; }}",
            waterfall["request"].as_str().unwrap(),
            waterfall["value"].as_str().unwrap()
        )
        .unwrap();
    }
    out.push_str("}\n");
    fs::write(Path::new(&env::var("OUT_DIR").unwrap()).join("protocol.rs"), out).unwrap();
}

/// typify keeps a `const` property as a plain string, so an untagged union of
/// blocks would accept a reasoning block as a text block. A one-value `enum`
/// becomes a checked unit enum instead.
///
/// The "other" member of an open union (`SessionEventOther`) allows any further
/// fields; typify keeps them (as a flattened map) only when
/// `additionalProperties` is a schema rather than `true`.
fn const_to_enum(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(constant) = map.remove("const") {
                map.entry("enum").or_insert_with(|| Value::Array(vec![constant]));
            }
            let open_member = map.get("title").and_then(Value::as_str).is_some_and(|title| title.ends_with("Other"));
            if open_member && map.get("additionalProperties") == Some(&Value::Bool(true)) {
                map.insert("additionalProperties".into(), Value::Object(Default::default()));
            }
            map.values_mut().for_each(const_to_enum);
        }
        Value::Array(items) => items.iter_mut().for_each(const_to_enum),
        _ => {}
    }
}

fn pascal(name: &str) -> String {
    name.split(|c: char| !c.is_ascii_alphanumeric()).filter(|part| !part.is_empty()).map(|part| part[..1].to_uppercase() + &part[1..]).collect()
}
