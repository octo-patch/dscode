//! UI-free client for a DSCODE runtime. It speaks the carrier protocol in
//! `docs/runtime-protocol.md`: Typert unary calls on `/api`, DSCODE operations on
//! `/dscode`, and NDJSON streams on `/stream`, over the local Host's Unix socket
//! or a `dscode server` TCP listener with its bearer token.

mod client;
mod error;
mod http;
pub mod launcher;
pub mod protocol;
pub mod runtimes;
mod stream;
mod target;

pub use client::{Client, HostStatus};
pub use error::{Error, Result};
pub use launcher::{Launcher, Location};
pub use runtimes::Runtimes;
pub use stream::{Stream, StreamEvent, TypedStream};
pub use target::Target;
