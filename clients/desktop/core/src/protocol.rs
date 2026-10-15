//! Typed DSCODE operations, generated from `protocol/dscode-runtime.schema.json`
//! by `build.rs`. Call them with [`Client::invoke`](crate::Client::invoke) and
//! [`Client::watch`](crate::Client::watch).

use crate::client::HostStatus;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::fmt;

/// A wire protocol version. The same major is compatible; a newer minor only
/// adds operations and fields.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Protocol {
    pub major: u32,
    pub minor: u32,
}

impl fmt::Display for Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

/// Whether this client can use a Host, by the rules of
/// `plugins/local-carrier/protocol.mjs`. A Host from before negotiation reports
/// no protocol; it only matches its own DSCODE release, which this client is not.
/// `Ok(true)` means the Host is on an older minor, so newer operations may be
/// missing there (`dscode/unknown-method`).
pub fn compatibility(status: &HostStatus, client: Protocol) -> Result<bool, String> {
    let Some(host) = status.protocol else {
        return Err(format!("runs DSCODE {}, which predates protocol negotiation; update the runtime", status.version));
    };
    if host.major != client.major {
        let older = if host.major < client.major { "the runtime" } else { "this client" };
        return Err(format!("speaks protocol {host} (DSCODE {}); this client speaks {client}. Update {older}", status.version));
    }
    Ok(host.minor < client.minor)
}

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

/// An upstream Typert call: `POST /api/<NAME>` with `{args}`.
pub trait TypertMethod {
    const NAME: &'static str;
    type Args: Serialize;
    type Result: DeserializeOwned;
}

/// An upstream Typert stream (`$events`, `session/follow`).
pub trait TypertStream {
    const NAME: &'static str;
    type Args: Serialize;
    type Item: DeserializeOwned;
}

/// An interactive request on `$events` that a client answers: its payload and
/// the value of a `result` outcome.
pub trait Waterfall {
    const EVENT: &'static str;
    type Payload: DeserializeOwned;
    type Answer: Serialize;
}

include!(concat!(env!("OUT_DIR"), "/protocol.rs"));

impl types::SessionWireEvent {
    /// Read the event as a [`types::SessionEvent`]. Upstream types the follow
    /// stream's events generically (`type` plus JSON `data`); recognizing the
    /// merge-extensible kinds is the reader's job. A kind the contract does not
    /// describe comes back as `SessionEvent::Other`.
    pub fn known(&self) -> Result<types::SessionEvent, serde_json::Error> {
        serde_json::from_value(serde_json::to_value(self)?)
    }
}

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

    #[test]
    fn negotiates_on_the_protocol_major() {
        let client = Protocol { major: 2, minor: 3 };
        let status = |protocol: Option<Protocol>| -> HostStatus {
            serde_json::from_value(json!({"version": "9.9.9", "pid": 1, "protocol": protocol})).unwrap()
        };
        assert_eq!(compatibility(&status(Some(Protocol { major: 2, minor: 3 })), client), Ok(false));
        assert_eq!(compatibility(&status(Some(Protocol { major: 2, minor: 9 })), client), Ok(false));
        assert_eq!(compatibility(&status(Some(Protocol { major: 2, minor: 1 })), client), Ok(true));
        assert!(compatibility(&status(Some(Protocol { major: 1, minor: 9 })), client).unwrap_err().contains("Update the runtime"));
        assert!(compatibility(&status(Some(Protocol { major: 3, minor: 0 })), client).unwrap_err().contains("Update this client"));
        let legacy: HostStatus = serde_json::from_value(json!({"version": "0.7.48", "pid": 1})).unwrap();
        assert!(compatibility(&legacy, client).unwrap_err().contains("predates protocol negotiation"));
        assert_eq!(PROTOCOL.major, 1);
    }
}
