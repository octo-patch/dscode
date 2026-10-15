//! UI-free client for a DSCODE runtime. It speaks the carrier protocol in
//! `docs/runtime-protocol.md`: Typert unary calls on `/api`, DSCODE operations on
//! `/dscode`, and NDJSON streams on `/stream`, over the local Host's Unix socket
//! or a `dscode server` TCP listener with its bearer token.

mod client;
mod error;
mod http;
pub mod protocol;
mod stream;
mod target;

pub use client::{Client, HostStatus};
pub use error::{Error, Result};
pub use stream::{Stream, StreamEvent, TypedStream};
pub use target::Target;
