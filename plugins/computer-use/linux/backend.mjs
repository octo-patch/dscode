import { LinuxHelperClient, helperPath } from './client.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';

export class LinuxBackend {
  name = 'linux-atspi';
  helperPath = helperPath;
  actionInstance = new AsyncLocalStorage();
  observationScope = new AsyncLocalStorage();
  control = new AsyncLocalStorage();
  constructor(config, client = new LinuxHelperClient({ timeoutMs: config.actionTimeoutMs })) { this.config = config; this.client = client; }
  withInstance(instance, run) { return this.actionInstance.run(instance, run); }
  withScope(scope, run) { return this.observationScope.run(scope, run); }
  withControl(token, run) { return this.control.run(token, run); }
  invoke(command, signal, timeout) {
    return this.client.invoke({ ...command, expectedInstance: this.actionInstance.getStore(), leaseToken: this.control.getStore() }, signal, timeout);
  }
  async health(signal) {
    try {
      this.capabilities = await this.invoke({ command: 'health' }, signal);
      const c = this.capabilities;
      return { helperVersion: 'dscode-linux-1', helperSha256: '', ready: c.accessibility === 'granted' || c.screenshot === 'available',
        accessibility: c.accessibility, screenRecording: c.screenshot === 'available' ? 'granted' : 'unavailable', error: c.reason };
    } catch (error) {
      this.capabilities = { ready: false, reason: error.message };
      return { helperVersion: 'dscode-linux-1', helperSha256: '', ready: false, accessibility: 'unavailable', screenRecording: 'unavailable', error: error.message };
    }
  }
  listApps(signal) { return this.invoke({ command: 'list-apps' }, signal); }
  resolveApp(selector, signal) { return this.invoke({ command: 'resolve-app', selector }, signal); }
  observe(app, options, signal) {
    return this.invoke({ command: 'observe', app, options: { ...options, scope: this.observationScope.getStore() } }, signal,
      this.capabilities?.session === 'wayland' && options.screenshot !== 'none' ? 120000 : undefined);
  }
  act(request, signal) {
    return this.invoke({ command: 'act', request: { ...request, allowDesktopInput: this.config.allowAllApps }, limits: { maxNodes: this.config.maxNodes, maxDepth: this.config.maxDepth, maxTextBytes: this.config.maxTextBytes, scope: this.observationScope.getStore() } }, signal);
  }
  acquire(owner, token, ttlMs, signal) { return this.invoke({ command: 'control-acquire', owner, token, ttlMs }, signal); }
  release(token) { return this.invoke({ command: 'control-release', token }, AbortSignal.timeout(2000)); }
  waitChange(eventEpoch, timeoutMs, signal) { return this.invoke({ command: 'wait-change', eventEpoch, timeoutMs }, signal, timeoutMs + 5000); }
  async pause(paused) {
    // Separate transport reaches the shared pause flag even during another wait.
    const client = new LinuxHelperClient();
    try { return await client.invoke({ command: 'control-pause', paused }, AbortSignal.timeout(15000)); }
    finally { await client.dispose(); }
  }
  async connectPortal(signal, desktop = true) {
    const result = await this.invoke({ command: 'connect-portal', desktop }, signal, 120000);
    await this.health(signal); return result;
  }
  async openSettings() { throw Error('Use /computer connect for a Wayland Portal session; /computer status reports missing Linux capabilities.'); }
  async visualizeCursor() { return { visible: false, reason: 'Linux uses the desktop cursor; no separate agent overlay is installed.' }; }
  async dispose() { await this.client.dispose(); this.actionInstance.disable(); this.observationScope.disable(); this.control.disable(); }
}
