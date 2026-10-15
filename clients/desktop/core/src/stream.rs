use crate::error::{Error, Result};
use crate::http::{self, Conn};
use crate::target::Target;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::marker::PhantomData;
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// What a stream delivers, in order. `End` and `Failed` are terminal; after
/// either, or after the stream is closed, the channel disconnects.
#[derive(Debug)]
pub enum StreamEvent {
    Item(Value),
    End,
    Failed(Error),
}

/// One logical stream: one `POST /stream` exchange holding its own connection.
/// Items arrive on a channel that works from both blocking and async code
/// (`recv` or `receiver().recv_async()`). Dropping the stream aborts it.
pub struct Stream {
    endpoint: String,
    rx: flume::Receiver<StreamEvent>,
    writer: Mutex<Conn>,
    closed: Arc<AtomicBool>,
}

impl Stream {
    pub(crate) fn open(target: &Target, endpoint: &str, payload: Value) -> Result<Stream> {
        let mut conn = Conn::connect(target, Some(CONNECT_TIMEOUT))?;
        conn.write_all(http::head(target, "/stream", "application/x-ndjson", None).as_bytes())?;
        let mut opening = serde_json::to_vec(&json!({"endpoint": endpoint, "payload": payload})).expect("JSON values serialize");
        opening.push(b'\n');
        http::write_chunk(&mut conn, &opening)?;
        let reader = conn.try_clone()?;
        let closed = Arc::new(AtomicBool::new(false));
        let (tx, rx) = flume::unbounded();
        let flag = closed.clone();
        thread::Builder::new()
            .name(format!("dscode-stream {endpoint}"))
            .spawn(move || pump(reader, tx, flag))?;
        Ok(Stream { endpoint: endpoint.to_owned(), rx, writer: Mutex::new(conn), closed })
    }

    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    /// Block until the next event; `None` once the stream is over.
    pub fn recv(&self) -> Option<StreamEvent> {
        self.rx.recv().ok()
    }

    /// The underlying channel, for `recv_async`, `select` or a UI executor.
    pub fn receiver(&self) -> &flume::Receiver<StreamEvent> {
        &self.rx
    }

    /// Send one uplink item (an answer to an interactive login prompt, say).
    pub fn send(&self, item: &Value) -> Result<()> {
        let mut line = serde_json::to_vec(item).expect("JSON values serialize");
        line.push(b'\n');
        let mut writer = self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        http::write_chunk(&mut *writer, &line)?;
        Ok(())
    }

    /// Abort the stream. The reader stops without reporting a failure.
    pub fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.writer.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).shutdown();
        }
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.close();
    }
}

/// A [`Stream`] whose items decode to `T`, as [`Client::watch`](crate::Client::watch) opens.
pub struct TypedStream<T> {
    inner: Stream,
    item: PhantomData<fn() -> T>,
}

impl<T: DeserializeOwned> TypedStream<T> {
    pub(crate) fn new(inner: Stream) -> Self {
        TypedStream { inner, item: PhantomData }
    }

    /// Block for the next item; `None` once the stream ended or was closed.
    pub fn recv(&self) -> Option<Result<T>> {
        match self.inner.recv()? {
            StreamEvent::Item(item) => Some(serde_json::from_value(item.clone()).map_err(|error| {
                let raw = item.to_string();
                let shown = raw.char_indices().nth(400).map_or(raw.as_str(), |(cut, _)| &raw[..cut]);
                Error::protocol(format!("{} sent an unexpected item: {error}: {shown}", self.inner.endpoint()))
            })),
            StreamEvent::End => None,
            StreamEvent::Failed(error) => Some(Err(error)),
        }
    }

    /// The untyped stream, for its channel or to close it.
    pub fn stream(&self) -> &Stream {
        &self.inner
    }
}

fn pump(reader: Conn, tx: flume::Sender<StreamEvent>, closed: Arc<AtomicBool>) {
    let terminal = read_frames(reader, &tx);
    if closed.load(Ordering::SeqCst) {
        return;
    }
    let _ = tx.send(match terminal {
        Ok(Some(event)) => event,
        Ok(None) => StreamEvent::Failed(Error::protocol("stream closed without an end frame")),
        Err(error) => StreamEvent::Failed(error),
    });
}

/// Forward `{item}` lines; return the terminal frame, or `None` if the body
/// ended without one.
fn read_frames(reader: Conn, tx: &flume::Sender<StreamEvent>) -> Result<Option<StreamEvent>> {
    let response = http::read_response(reader)?;
    for line in response.body.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let frame: Value = serde_json::from_str(&line).map_err(|error| Error::protocol(format!("bad stream line: {error}")))?;
        if let Some(item) = frame.get("item") {
            if tx.send(StreamEvent::Item(item.clone())).is_err() {
                return Ok(Some(StreamEvent::End));
            }
        } else if let Some(error) = frame.get("error") {
            return Ok(Some(StreamEvent::Failed(Error::remote(error))));
        } else if frame.get("end").and_then(Value::as_bool) == Some(true) {
            return Ok(Some(StreamEvent::End));
        }
    }
    if response.status == 401 {
        return Ok(Some(StreamEvent::Failed(Error::Remote { code: "dscode/unauthorized".into(), message: "unauthorized".into() })));
    }
    Ok(None)
}
