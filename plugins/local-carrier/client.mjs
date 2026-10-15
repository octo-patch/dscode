// Client half of the local carrier. `fetch` and `openStream` match
// dsh-client-connection's ClientTransportHooks, so a Cordis client can install
// them directly; `call` is the decoded unary form for scripts.
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ndjson, STREAM_PATH } from './index.mjs';

/** Fetch-shaped unary transport over the Unix socket. */
export function socketFetch(socketPath) {
  return (input, init = {}) => new Promise((resolve, reject) => {
    const url = new URL(String(input), 'http://localhost');
    const req = request({ socketPath, path: url.pathname + url.search, method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)) }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
      res.on('error', reject);
    });
    req.on('error', reject);
    init.signal?.addEventListener('abort', () => req.destroy(init.signal.reason), { once: true });
    req.end(init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : Buffer.from(init.body));
  });
}

/** Decoded unary call through the shared /api channel; Typert payloads carry one `args` object. */
export async function call(socketPath, method, args, signal) {
  const payload = { args };
  const rpcId = randomUUID();
  const response = await socketFetch(socketPath)(`/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }), signal });
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { throw Error(`/api ${method} returned ${response.status}: ${raw.slice(0, 200)}`); }
  if (body?.type !== 'server-response' || body.rpcId !== rpcId) throw Error(`unexpected /api response (${response.status})`);
  return body.result;
}

/** One DSCODE registry operation; resolves its value or throws its {code, message} failure. */
export async function callDscode(socketPath, name, args = {}, signal) {
  const response = await socketFetch(socketPath)(`/dscode/${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ args }), signal });
  const result = await response.json();
  if (result?.ok === true) return result.value ?? undefined;
  throw Object.assign(Error(result?.error?.message ?? `DSCODE ${name} failed (${response.status})`), { name: 'RemoteFailure', code: result?.error?.code ?? 'dscode/internal' });
}

/** Open one DSCODE registry stream; uplink items reach the Host stream in order. */
export function openDscodeStream(socketPath, name, args = {}, signal, uplink) {
  return openStream(socketPath, `dscode/${name}`, { args }, signal, uplink);
}

/** Gateway stream opener: yields decoded items, throws the Remote failure on {error}. */
export async function* openStream(socketPath, endpoint, payload, signal, uplink) {
  const req = request({ socketPath, path: STREAM_PATH, method: 'POST', headers: { 'content-type': 'application/x-ndjson' } });
  const response = new Promise((resolve, reject) => { req.once('response', resolve); req.once('error', reject); });
  const abort = () => req.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  req.write(JSON.stringify({ endpoint, payload }) + '\n');
  const pump = (async () => {
    if (uplink) for await (const item of uplink) req.write(JSON.stringify(item) + '\n');
  })().catch(() => req.destroy());
  try {
    const res = await response;
    for await (const frame of ndjson(res.setEncoding('utf8'))) {
      if ('item' in frame) yield frame.item;
      else if (frame.error) throw Object.assign(Error(frame.error.message ?? frame.error.code ?? 'remote stream failed'), { remote: frame.error });
      else if (frame.end) return;
    }
    if (!signal?.aborted) throw Error('stream closed without an end frame');
  } finally {
    signal?.removeEventListener('abort', abort);
    // An uplink may never settle; closing the request ends its writes without waiting for it.
    req.destroy(); void pump;
  }
}

/** ClientTransportHooks for installConnection(ctx, { transport }). */
export function transportHooks(socketPath) {
  return { fetch: socketFetch(socketPath), openStream: (endpoint, payload, signal, uplink) => openStream(socketPath, endpoint, payload, signal, uplink), ownsHost: true };
}
