// Process-local policy adapter: never persist elevated permission events. This
// plugin is mounted only by the explicit `server --yolo` Host overlay.
export const name = 'dscode-server-yolo';
export const inject = ['approval', 'sandboxPolicy', 'permissionPresets', 'systemPrompt'];

export const YOLO_CONTEXT = 'This Host was explicitly started with dscode server --yolo. All sessions on this Host have unrestricted file, shell, network, browser and application access under the server OS account. Permission requests are automatically allowed and audited; do not ask the user to confirm tool permissions, browser site/developer grants or application access. For sensitive desktop actions, call computer_confirm as usual: it returns a one-use token automatically. Respect user cancellation, browser handoff, valid targets and fresh observations. OS permissions, authentication and missing information still require their normal handling. YOLO lasts only for this server process; restart without --yolo to restore session policies.';

export function apply(ctx) {
  // These upstream capability seams are shared by new, resumed and child agents.
  // Restore descriptors on disposal; request() remains intact so its durable
  // asked/decided audit pair and open-turn validation also cover automatic grants.
  const replace = (object, key, value) => ctx.effect(() => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, writable: true, value });
    return () => { if (descriptor) Object.defineProperty(object, key, descriptor); else delete object[key]; };
  });
  const resolve = ctx.sandboxPolicy.resolve.bind(ctx.sandboxPolicy);
  replace(ctx.sandboxPolicy, 'resolve', request => resolve({ ...request, mode: 'danger-full-access' }));
  replace(ctx.approval, 'overrideOf', () => 'ask');
  replace(ctx.approval, 'serverYolo', true);
  replace(ctx.approval, 'decide', async req => req.signal?.aborted ? 'cancelled' : 'allowed-once');
  const presets = ctx.permissionPresets;
  const serverPreset = {
    sandbox: 'danger-full-access', approval: 'ask', name: 'Server YOLO',
    description: 'Server-wide automatic approval. Restart the server without --yolo to restore session policies.',
  };
  const resolvePreset = presets.resolve.bind(presets);
  replace(presets, 'resolve', name => name === 'server-yolo' ? serverPreset : resolvePreset(name));
  // Keep the stored preset table and derive()/pinInitialPermission() unchanged:
  // even a partially seeded session must never derive a durable YOLO identity.
  replace(presets, 'current', () => 'server-yolo');
  replace(presets, 'names', ['server-yolo']);
  const applyPreset = presets.apply.bind(presets);
  replace(presets, 'apply', (session, preset, setApproval) => {
    // A child may still pin its normal fallback policy. Never serialize YOLO.
    if (preset !== 'server-yolo') return applyPreset(session, preset, setApproval);
  });
  ctx.systemPrompt.context({ name: 'dscode:server-yolo', order: 10000, text: () => YOLO_CONTEXT });
}
