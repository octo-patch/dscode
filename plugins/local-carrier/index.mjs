// Local carrier for the upstream Typert API: the same /api RPC dispatch and
// Gateway streams the browser and Desktop use, over an owner-only Unix socket
// instead of a cookie-authenticated loopback port. Filesystem permissions are
// the authentication, as for the session bridge; nothing listens on TCP.
import { createServer } from 'node:http';
import { chmodSync, closeSync, mkdirSync, openSync, rmSync, statSync } from 'node:fs';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import z from '@deepseek-ai/schemastery';

export const name = 'dscode-local-carrier';
export const inject = ['connection', 'typertGateway'];
export const Config = z.object({
  socketPath: z.string().description('Absolute socket path; defaults to $DSH_HOME/run/host.sock'),
  host: z.boolean().default(false).description('Serve as the shared Host: hold the Host lock and offer host/status and host/shutdown'),
  idleExitMs: z.number().min(0).default(0).description('Exit after this long with no attached terminal and no running turn; 0 never exits'),
});

export const STREAM_PATH = '/stream';
/** Unary DSCODE operations (packages/tui/src/host/registry.ts): POST /dscode/<name> with {args}. */
export const DSCODE_PREFIX = '/dscode/';
/** Stream endpoints with this prefix open a DSCODE registry stream instead of a Typert one. */
export const DSCODE_STREAM_PREFIX = 'dscode/';

// The registry is an optional Host value: without it DSCODE endpoints report unknown.
const registryOf = ctx => ctx.get('dscodeRemote');
const failure = error => ({ code: typeof error?.code === 'string' && error.name === 'RemoteFailure' ? error.code : 'dscode/internal', message: error instanceof Error ? error.message : String(error) });

async function dscodeUnary(ctx, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const control = new AbortController();
  res.on('close', () => control.abort());
  const name = decodeURIComponent(req.url.slice(DSCODE_PREFIX.length));
  let result;
  try {
    const registry = registryOf(ctx);
    if (registry === undefined) throw Object.assign(Error('DSCODE operations are not mounted on this Host'), { name: 'RemoteFailure', code: 'dscode/unavailable' });
    const body = chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'));
    result = { ok: true, value: await registry.invoke(name, body.args ?? {}, control.signal) ?? null };
  } catch (error) { result = { ok: false, error: failure(error) }; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result));
}
export const defaultSocketPath = (home = process.env.DSH_HOME) => join(home, 'run', 'host.sock');

/** Split an NDJSON byte stream into parsed values. */
export async function* ndjson(source) {
  let buffer = '';
  for await (const chunk of source) {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line);
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}

async function unary(handler, req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const response = await handler.fetch(new Request(`http://localhost${req.url}`, { method: req.method, headers, body }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of Readable.fromWeb(response.body)) res.write(chunk);
  res.end();
}

// One HTTP exchange per logical stream: the request body carries the opening
// {endpoint, payload} line and then uplink items; the response carries
// {item} lines and ends with exactly one {end} or {error}.
async function stream(ctx, req, res, activity) {
  const control = new AbortController();
  res.on('close', () => control.abort());
  let counted = false;
  const lines = ndjson(req.setEncoding('utf8'));
  const send = value => res.write(JSON.stringify(value) + '\n');
  let dscode = false;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  try {
    const first = await lines.next();
    if (first.done || typeof first.value?.endpoint !== 'string') throw Error('stream must open with {endpoint, payload}');
    const uplink = { [Symbol.asyncIterator]: () => lines };
    const { endpoint, payload } = first.value;
    // Each attached terminal holds one forwarded-event stream for its lifetime.
    if (endpoint === '$events') { counted = true; activity.clients += 1; }
    activity.streams += 1;
    control.signal.addEventListener('abort', () => {
      activity.streams -= 1;
      if (counted) activity.clients -= 1;
      activity.lastActivity = Date.now();
    }, { once: true });
    if (endpoint.startsWith(DSCODE_STREAM_PREFIX)) {
      dscode = true;
      const registry = registryOf(ctx);
      if (registry === undefined) throw Object.assign(Error('DSCODE operations are not mounted on this Host'), { name: 'RemoteFailure', code: 'dscode/unavailable' });
      for await (const item of registry.open(endpoint.slice(DSCODE_STREAM_PREFIX.length), payload?.args ?? {}, uplink, control.signal)) send({ item });
    } else {
      const items = await ctx.typertGateway.wireStream.open(endpoint, payload, uplink, ctx.connection.operator, control.signal);
      for await (const item of items) send({ item });
    }
    send({ end: true });
  } catch (error) {
    if (!control.signal.aborted) send({ error: dscode ? failure(error) : ctx.typertGateway.wireStream.failure(error) });
  } finally { res.end(); }
}

/** Acquire the Host lock beside the socket, or throw when another Host holds it. */
async function lockHost(socketPath) {
  const fd = openSync(join(dirname(socketPath), 'host.lock'), 'a', 0o600);
  try { await tryLockExclusive(fd); } catch (error) { closeSync(fd); throw Object.assign(Error('another DSCODE Host already serves this state directory'), { cause: error, code: 'DSCODE_HOST_RUNNING' }); }
  return () => closeSync(fd);
}

export async function apply(ctx, config = {}) {
  const socketPath = config.socketPath || defaultSocketPath();
  const handler = ctx.connection.createSharedFetchHandler('/api');
  const activity = { clients: 0, streams: 0, lastActivity: Date.now(), startedAt: Date.now() };
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(socketPath), 0o700);
  // The Host lock comes first: only its holder may replace a stale socket.
  if (config.host) {
    let unlock;
    try { unlock = await lockHost(socketPath); } catch (error) {
      // Another Host serves this state directory (or is still shutting down):
      // this process has nothing to serve, so it leaves; the starter retries.
      ctx.logger?.warn?.(error.message);
      setTimeout(() => ctx.get('appExit')?.(3), 0);
      return;
    }
    ctx.effect(() => unlock, 'local carrier: Host lock');
  }
  const server = createServer((req, res) => {
    // A status probe (a launcher checking for a Host) must not keep an idle Host alive.
    if (req.url !== `${DSCODE_PREFIX}host%2Fstatus`) activity.lastActivity = Date.now();
    const route = req.url === STREAM_PATH && req.method === 'POST' ? stream(ctx, req, res, activity)
      : req.url.startsWith(DSCODE_PREFIX) && req.method === 'POST' ? dscodeUnary(ctx, req, res)
        : unary(handler, req, res);
    route.catch(error => {
      ctx.logger?.warn?.(`local carrier: ${error.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  ctx.effect(() => {
    try { if (statSync(socketPath).isSocket()) rmSync(socketPath); } catch { /* no stale socket */ }
    // The directory is 0700 before the socket exists, so the umask-mode window before chmod admits no other user.
    server.listen(socketPath, () => chmodSync(socketPath, 0o600));
    return () => new Promise(resolve => { server.closeAllConnections(); server.close(() => { rmSync(socketPath, { force: true }); resolve(); }); });
  }, 'local carrier: Unix socket');
  if (!config.host) return;
  const running = () => (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running').length;
  const exit = code => setTimeout(() => ctx.get('appExit')?.(code), 50);
  ctx.inject(['dscodeRemote'], scoped => scoped.effect(() => {
    const offs = [
      scoped.dscodeRemote.method('host/status', () => ({
        pid: process.pid, startedAt: activity.startedAt, socketPath, clients: activity.clients, streams: activity.streams,
        sessions: (ctx.get('agents')?.list() ?? []).length, running: running(), idleExitMs: config.idleExitMs ?? 0,
      })),
      scoped.dscodeRemote.method('host/shutdown', () => { exit(0); return { stopping: true }; }),
    ];
    return () => { for (const off of offs) off(); };
  }, 'local carrier: Host methods'));
  // Idle exit: no attached terminal, no running turn, for idleExitMs.
  if ((config.idleExitMs ?? 0) > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        if (activity.clients > 0 || activity.streams > 0 || running() > 0) { activity.lastActivity = Date.now(); return; }
        if (Date.now() - activity.lastActivity >= config.idleExitMs) { clearInterval(timer); exit(0); }
      }, Math.min(2000, config.idleExitMs));
      timer.unref?.();
      return () => clearInterval(timer);
    }, 'local carrier: idle exit');
  }
}
