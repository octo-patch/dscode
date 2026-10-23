import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
// Bump revision for an incompatible DSCODE method, stream or semantic change.
// Upstream Typert has no independent compatibility promise: keep its exact pin.
export const RUNTIME_PROTOCOL = Object.freeze({ revision: 2, upstream: manifest.dependencies['@deepseek-ai/dsh'], capabilities: ['host/diagnostics', 'session/deliver-idempotency', 'session/interrupt-turn'] });

/** Old servers require equal application versions; declared contracts must match explicitly. */
export function runtimeCompatibility(status, version = manifest.version, protocol = RUNTIME_PROTOCOL) {
  const remote = status?.protocol;
  if (remote === undefined) {
    const ok = status?.version === version;
    return { ok, mode: 'legacy', detail: `server ${status?.version ?? 'unknown'}, client ${version}${ok ? ' (legacy version check)' : '; this server has no protocol declaration; match application versions'}` };
  }
  const ok = remote?.revision === protocol.revision && typeof remote?.upstream === 'string' && remote.upstream === protocol.upstream;
  return { ok, mode: 'protocol', detail: `server ${status?.version ?? 'unknown'}, client ${version}; protocol ${remote?.revision ?? 'unknown'}, upstream ${remote?.upstream ?? 'unknown'}${ok ? ' (compatible)' : `; requires protocol ${protocol.revision} and upstream ${protocol.upstream}`}` };
}

export function requireCompatibleRuntime(status, version = manifest.version) {
  const result = runtimeCompatibility(status, version);
  if (!result.ok) throw Object.assign(Error(`incompatible runtime: ${result.detail}; update the incompatible side, then restart dscode`), { code: 'dscode/version-mismatch' });
  return result;
}
