//! Typed DSCODE operations, generated from `protocol/dscode-runtime.schema.json`
//! by `build.rs`. Call them with [`Client::invoke`](crate::Client::invoke) and
//! [`Client::watch`](crate::Client::watch).

use serde::de::DeserializeOwned;
use serde::Serialize;

/// A unary DSCODE method.
pub trait Method {
    const NAME: &'static str;
    type Args: Serialize;
    type Result: DeserializeOwned;
}

/// A DSCODE stream: its arguments and the items it sends.
pub trait Watch {
    const NAME: &'static str;
    type Args: Serialize;
    type Item: DeserializeOwned;
}

/// A stream that reads items from the client after it opens.
pub trait Uplink: Watch {
    type Uplink: Serialize;
}

include!(concat!(env!("OUT_DIR"), "/protocol.rs"));

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn edge_shapes_match_the_wire() {
        // No arguments travel as an empty object; a method without a value answers null.
        assert_eq!(serde_json::to_value(types::NoArgs(Default::default())).unwrap(), json!({}));
        let _: <ops::ModelsSubagentOverride as Method>::Result = serde_json::from_value(json!(null)).unwrap();
        let preview: <ops::ModelsCompactionPreview as Method>::Result = serde_json::from_value(json!(null)).unwrap();
        assert!(preview.0.is_none());
        // Optional fields are omitted, not sent as null; camelCase names survive.
        let args = types::ModelsSaveArgs {
            selection: types::DshAgentModelSelection { provider: "p".into(), model: "m".into(), reasoning_effort: None },
        };
        assert_eq!(serde_json::to_value(args).unwrap(), json!({"selection": {"provider": "p", "model": "m"}}));
        assert_eq!(<ops::ModelsDefaults as Watch>::NAME, "models/defaults");
    }
}
