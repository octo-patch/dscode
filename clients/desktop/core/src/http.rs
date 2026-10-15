//! The minimal HTTP/1.1 the carrier needs: POST with a JSON body, and POST with
//! a chunked NDJSON body that stays open for uplink items. Blocking I/O keeps the
//! core independent of any async executor; streams run on their own threads.

use crate::error::{Error, Result};
use crate::target::Target;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// Idle streams send TCP keepalive probes so NAT between machines does not drop them.
const KEEPALIVE: Duration = Duration::from_secs(30);

pub(crate) enum Conn {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Conn {
    /// Connect, bounding only the TCP handshake by `timeout`.
    pub(crate) fn connect(target: &Target, timeout: Option<Duration>) -> io::Result<Conn> {
        let conn = match target {
            #[cfg(unix)]
            Target::Socket(path) => Conn::Unix(UnixStream::connect(path)?),
            Target::Remote { host, port, .. } => {
                let mut last = None;
                let mut stream = None;
                for addr in (host.as_str(), *port).to_socket_addrs()? {
                    let attempt = match timeout {
                        Some(timeout) => TcpStream::connect_timeout(&addr, timeout),
                        None => TcpStream::connect(addr),
                    };
                    match attempt {
                        Ok(s) => {
                            stream = Some(s);
                            break;
                        }
                        Err(error) => last = Some(error),
                    }
                }
                let stream = stream.ok_or_else(|| last.unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no address")))?;
                stream.set_nodelay(true)?;
                socket2::SockRef::from(&stream)
                    .set_tcp_keepalive(&socket2::TcpKeepalive::new().with_time(KEEPALIVE).with_interval(KEEPALIVE))?;
                Conn::Tcp(stream)
            }
        };
        Ok(conn)
    }

    pub(crate) fn try_clone(&self) -> io::Result<Conn> {
        Ok(match self {
            #[cfg(unix)]
            Conn::Unix(s) => Conn::Unix(s.try_clone()?),
            Conn::Tcp(s) => Conn::Tcp(s.try_clone()?),
        })
    }

    /// Close both directions; a reader blocked on the other handle wakes with EOF.
    pub(crate) fn shutdown(&self) {
        let _ = match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.shutdown(Shutdown::Both),
            Conn::Tcp(s) => s.shutdown(Shutdown::Both),
        };
    }

    /// Bound reads and writes; `None` waits indefinitely, as a stream must.
    pub(crate) fn set_timeouts(&self, timeout: Option<Duration>) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.set_read_timeout(timeout).and_then(|_| s.set_write_timeout(timeout)),
            Conn::Tcp(s) => s.set_read_timeout(timeout).and_then(|_| s.set_write_timeout(timeout)),
        }
    }
}

impl Read for Conn {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.read(buf),
            Conn::Tcp(s) => s.read(buf),
        }
    }
}

impl Write for Conn {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.write(buf),
            Conn::Tcp(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Conn::Unix(s) => s.flush(),
            Conn::Tcp(s) => s.flush(),
        }
    }
}

/// Request head for `path` on `target`, with the bearer token on TCP.
pub(crate) fn head(target: &Target, path: &str, content_type: &str, body: Option<usize>) -> String {
    let host = match target {
        Target::Remote { .. } => target.to_string(),
        #[cfg(unix)]
        Target::Socket(_) => "localhost".into(),
    };
    let mut head = format!("POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: {content_type}\r\nAccept: */*\r\n");
    match body {
        Some(length) => head.push_str(&format!("Content-Length: {length}\r\nConnection: close\r\n")),
        None => head.push_str("Transfer-Encoding: chunked\r\n"),
    }
    if let Target::Remote { token, .. } = target {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("\r\n");
    head
}

/// Write one chunk of a chunked request body.
pub(crate) fn write_chunk(w: &mut impl Write, data: &[u8]) -> io::Result<()> {
    if data.is_empty() {
        return Ok(());
    }
    let mut frame = format!("{:x}\r\n", data.len()).into_bytes();
    frame.extend_from_slice(data);
    frame.extend_from_slice(b"\r\n");
    w.write_all(&frame)?;
    w.flush()
}

pub(crate) struct Response {
    pub status: u16,
    pub body: Box<dyn BufRead + Send>,
}

impl Response {
    pub(crate) fn text(mut self) -> Result<(u16, String)> {
        let mut text = String::new();
        self.body.read_to_string(&mut text)?;
        Ok((self.status, text))
    }
}

/// Read a response head and frame its body by `Transfer-Encoding` or `Content-Length`.
pub(crate) fn read_response(conn: Conn) -> Result<Response> {
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(Error::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed before a response")));
        }
        let status: u16 = line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .ok_or_else(|| Error::protocol(format!("bad status line {:?}", line.trim_end())))?;
        let mut chunked = false;
        let mut length = None;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header)? == 0 {
                return Err(Error::Io(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed in headers")));
            }
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                let value = value.trim();
                if name.eq_ignore_ascii_case("transfer-encoding") && value.to_ascii_lowercase().contains("chunked") {
                    chunked = true;
                } else if name.eq_ignore_ascii_case("content-length") {
                    length = value.parse::<u64>().ok();
                }
            }
        }
        // An interim 1xx response is followed by the real one.
        if (100..200).contains(&status) {
            continue;
        }
        let body: Box<dyn BufRead + Send> = if chunked {
            Box::new(BufReader::new(Chunked { inner: reader, remaining: 0, done: false }))
        } else if let Some(length) = length {
            Box::new(reader.take(length))
        } else {
            Box::new(reader)
        };
        return Ok(Response { status, body });
    }
}

/// Decoder for a chunked response body.
struct Chunked<R> {
    inner: R,
    remaining: u64,
    done: bool,
}

impl<R: BufRead> Read for Chunked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.done || buf.is_empty() {
            return Ok(0);
        }
        if self.remaining == 0 {
            let mut size = String::new();
            if self.inner.read_line(&mut size)? == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "chunked body ended early"));
            }
            let size = size.trim_end().split(';').next().unwrap_or_default().trim();
            self.remaining = u64::from_str_radix(size, 16)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, format!("bad chunk size {size:?}")))?;
            if self.remaining == 0 {
                // Trailers, then the blank line that ends the body.
                loop {
                    let mut trailer = String::new();
                    if self.inner.read_line(&mut trailer)? == 0 || trailer.trim_end().is_empty() {
                        break;
                    }
                }
                self.done = true;
                return Ok(0);
            }
        }
        let want = buf.len().min(self.remaining as usize);
        let read = self.inner.read(&mut buf[..want])?;
        if read == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "chunk ended early"));
        }
        self.remaining -= read as u64;
        if self.remaining == 0 {
            let mut crlf = String::new();
            self.inner.read_line(&mut crlf)?;
        }
        Ok(read)
    }
}

/// `encodeURIComponent` for operation names (`host/status` → `host%2Fstatus`).
pub(crate) fn encode_component(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_chunked_bodies() {
        let raw = b"5\r\nhello\r\n7;ext=1\r\n, world\r\n0\r\nX-Trailer: 1\r\n\r\n";
        let mut body = String::new();
        Chunked { inner: &raw[..], remaining: 0, done: false }.read_to_string(&mut body).unwrap();
        assert_eq!(body, "hello, world");
    }

    #[test]
    fn rejects_a_truncated_chunk() {
        let raw = b"a\r\nhello";
        let mut body = String::new();
        assert!(Chunked { inner: &raw[..], remaining: 0, done: false }.read_to_string(&mut body).is_err());
    }

    #[test]
    fn encodes_like_encode_uri_component() {
        assert_eq!(encode_component("host/status"), "host%2Fstatus");
        assert_eq!(encode_component("a b~(c)"), "a%20b~(c)");
    }

    #[test]
    fn heads_carry_the_token_only_over_tcp() {
        let remote = Target::remote("http://box:7700", "dsk_x").unwrap();
        let head = head(&remote, "/stream", "application/x-ndjson", None);
        assert!(head.contains("Host: box:7700\r\n"));
        assert!(head.contains("Transfer-Encoding: chunked\r\n"));
        assert!(head.contains("Authorization: Bearer dsk_x\r\n"));
        #[cfg(unix)]
        {
            let local = Target::Socket("/tmp/host.sock".into());
            let head = super::head(&local, "/api/x", "application/json", Some(2));
            assert!(head.contains("Content-Length: 2\r\n") && !head.contains("Authorization"));
        }
    }
}
