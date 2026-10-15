// The wire protocol's version, separate from the DSCODE release, so a client
// and a runtime from different releases can work together. The Host reports it
// in `host/status`; clients decide with `protocolCompatibility`.
//
// - major: bumped for a breaking change (an operation removed or renamed, an
//   argument a client must now send, a field or value a client may rely on
//   removed or changed). Different majors never talk.
// - minor: bumped for an additive change (a new operation, a new optional
//   argument, a new field). A client on a newer minor than its Host finds some
//   operations missing (`dscode/unknown-method`); an older client ignores what
//   it does not know.
//
// `protocol/versions.json` records the schema fingerprint of every version, and
// `node scripts/protocol-schema.mjs --check` fails when the schema changed
// without a bump, or changed incompatibly without a major bump.

export const PROTOCOL = Object.freeze({ major: 1, minor: 0 });

export const formatProtocol = protocol => `${protocol.major}.${protocol.minor}`;

/**
 * Whether a client speaking `client` can use a Host whose `host/status` is
 * `status`. A Host from before protocol negotiation (DSCODE 0.7.48 and older)
 * reports no protocol; only the identical release is known to match it.
 * @returns `{compatible, reason?, hostBehind?}`. `reason` is a sentence for the
 * user; `hostBehind` means the Host's minor is older, so newer operations may be
 * missing there.
 */
export function protocolCompatibility(status, { protocol = PROTOCOL, version } = {}) {
  const host = status?.protocol;
  if (host === undefined || typeof host.major !== 'number') {
    if (version !== undefined && status?.version === version) return { compatible: true, hostBehind: false };
    return { compatible: false, reason: `runs DSCODE ${status?.version ?? 'before 0.7.48'}, which predates protocol negotiation; this client is DSCODE ${version ?? 'unknown'}. Update the runtime` };
  }
  if (host.major !== protocol.major) {
    const older = host.major < protocol.major ? 'the runtime' : 'this client';
    return { compatible: false, reason: `speaks protocol ${formatProtocol(host)} (DSCODE ${status.version ?? 'unknown'}); this client speaks ${formatProtocol(protocol)}. Update ${older}` };
  }
  return { compatible: true, hostBehind: (host.minor ?? 0) < protocol.minor };
}
