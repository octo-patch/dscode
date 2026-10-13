// Discovery for Host commands before the terminal has a receiving Agent.
// Execution remains in the native registry; only immutable descriptors live here.
const catalogs = new WeakMap();
function catalog(ctx) {
  let value = catalogs.get(ctx.root);
  if (!value) { value = { entries: new Set(), listeners: new Set() }; catalogs.set(ctx.root, value); }
  return value;
}
function notify(value) { for (const listener of value.listeners) listener(); }
export function registerStartupCommand(ctx, definition) {
  const unregister = ctx.commands.register(definition);
  const value = catalog(ctx);
  const descriptor = Object.freeze({ name: definition.name, description: definition.description,
    ...(definition.input ? { input: Object.freeze({ ...definition.input }) } : {}) });
  value.entries.add(descriptor); notify(value);
  const remove = () => { if (value.entries.delete(descriptor)) notify(value); };
  ctx.effect(() => remove);
  return () => { remove(); unregister(); };
}
export function startupCommands(ctx) {
  return [...new Map([...catalog(ctx).entries].map(d => [d.name, d])).values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function watchStartupCommands(ctx, listener) {
  const value = catalog(ctx);
  value.listeners.add(listener);
  return () => value.listeners.delete(listener);
}
