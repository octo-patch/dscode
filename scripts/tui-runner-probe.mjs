// Probe for verify-tui-runner.mjs. It swaps the terminal mount for an
// in-memory TTY (xterm headless), types into the real TUI like a user and
// asserts on the rendered screen. As a Harness plugin it probes the in-process
// terminal; scripts/tui-client-probe.mjs runs the same probe inside a separate
// terminal client. TUI_PROBE_SCENARIO selects the script: `session` runs the
// full conversation, `resume` checks that the resumed history paints.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { render } from 'ink';
import xterm from '@xterm/headless';
// Through the package specifier the runner itself is loaded by, so the probe
// patches the same module instance even when run from a copied checkout.
import { internals } from 'dsh-code/src/internals.ts';
import { createSplitStdin } from 'dsh-code/src/input-split.ts';
import { REPLY } from './fixture-model.mjs';

export const name = 'tui-runner-probe';
const COLUMNS = 120, ROWS = 40;
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Install the in-memory mount and run the scenario; `fail` is called on any failure. */
export function runProbe(fail) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const stdout = new PassThrough();
  Object.assign(stdout, { columns: COLUMNS, rows: ROWS, isTTY: true });
  const terminal = new xterm.Terminal({ cols: COLUMNS, rows: ROWS, scrollback: 5000, allowProposedApi: true, convertEol: true });
  let written = Promise.resolve();
  stdout.on('data', data => { written = written.then(() => new Promise(resolve => terminal.write(data.toString(), resolve))); });
  internals.mount = element => {
    const split = createSplitStdin(stdin);
    const instance = render(element, { exitOnCtrlC: false, patchConsole: false, stdin: split.stdin, stdout, stderr: new PassThrough() });
    return { rerender: next => instance.rerender(next), unmount() { try { instance.unmount(); } finally { split.dispose(); } } };
  };
  const screen = async () => {
    await written;
    const buffer = terminal.buffer.active, lines = [];
    for (let i = 0; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    // Wrapped transcript text is compared without the terminal's line breaks.
    return lines.join('\n');
  };
  const flat = async () => (await screen()).replace(/\s+/g, ' ');
  const waitFor = async (label, predicate, ms = 30000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const text = await flat();
      if (predicate(text)) { console.log(`TUI_PROBE_STEP ${label}`); return text; }
      await tick(50);
    }
    throw Error(`TUI probe timed out at "${label}". Screen:\n${await screen()}`);
  };
  const type = async text => { for (const char of text) { stdin.write(char); await tick(5); } };
  const enter = async text => { await type(text); await tick(150); stdin.write('\r'); };
  const scenario = process.env.TUI_PROBE_SCENARIO ?? 'session';

  void (async () => {
    await waitFor('composer ready', text => /fixture/i.test(text));
    if (scenario === 'resume') {
      await waitFor('resumed history painted', text => text.includes(`${REPLY} (fixture)`));
    } else if (scenario === 'attach') {
      // A second client delivers into this session; it must appear live here.
      console.log('TUI_PROBE_READY');
      await waitFor('other client message shown', text => text.includes('from the second client'));
      await waitFor('other client reply shown', text => text.split(`${REPLY} (fixture)`).length - 1 >= 1);
    } else if (scenario === 'model-resume') {
      // The status line reports the route of the session's last request, not the deployment default.
      await waitFor('session model in status line', text => /· fixture-b workspace-write/.test(text));
    } else if (scenario === 'slow-crash') {
      await enter('SLOW please');
      await waitFor('slow turn running', text => text.includes('Working slowly'));
      // The verifier kills this process here; the turn must keep running on the Host.
      console.log('TUI_PROBE_SLOW_RUNNING');
      await new Promise(() => {});
    } else if (scenario === 'reattach') {
      await waitFor('crashed turn visible', text => text.includes('SLOW please'));
      // The verifier forces tiny history pages: the earliest message must still be stitched in.
      await waitFor('full history paged in', text => text.includes('from the second client'));
      // The joined turn is still running on the Host, so Esc interrupts it.
      for (let i = 0; i < 40 && !(await flat()).includes('turn cancelled'); i++) { stdin.write('\x1b'); await tick(250); }
      await waitFor('joined turn interrupted', text => text.includes('turn cancelled'));
    } else {
      await enter('hello');
      await waitFor('streamed reply', text => text.includes(`${REPLY} (fixture)`));

      await enter('/session');
      // The transcript folds long command output; its first line is enough.
      await waitFor('registry command output', text => /Session: session-[0-9a-f-]{36}/.test(text));

      await enter('APPROVE writing outside');
      await waitFor('approval bar', text => /danger-full-access/.test(text) && text.includes('write'));
      stdin.write('n');
      await waitFor('rejection reported', text => text.includes('Tool finished') && /rejected/i.test(text));
      assert(!existsSync(process.env.FIXTURE_OUTSIDE_PATH), 'a rejected write must not create the file');

      await enter('ASK a question');
      await waitFor('question form', text => text.includes('Which color should the fixture use?'));
      stdin.write('\r');
      await waitFor('answer delivered', text => /Tool finished.*Blue/.test(text));

      // @-mention completion is answered by the Host's workspace file index.
      await type('@notes-for');
      await waitFor('mention candidates', text => text.includes('notes-for-probe.txt'));
      stdin.write('\x1b');
      await tick(150);
      for (let i = 0; i < '@notes-for'.length; i++) { stdin.write('\x7f'); await tick(5); }

      await enter('/title Probe Title');
      await waitFor('title applied', text => text.includes('Probe Title'));

      await enter('/usage');
      await waitFor('usage panel', text => text.includes('usage of this session'));
      stdin.write('\x1b');
      await enter('/jobs');
      await waitFor('jobs panel', text => text.includes('/jobs · background tasks'));
      stdin.write('\x1b');
      await tick(200);

      await enter('SLOW please');
      await waitFor('slow turn running', text => text.includes('Working slowly'));
      stdin.write('\x1b');
      await waitFor('turn interrupted', text => text.includes('turn cancelled'));

      await enter('/btw what is happening');
      await waitFor('side question answered', text => text.includes('Side questions (btw)') && text.includes('answered'));
      stdin.write('\x1b');
      await tick(200);

      await enter('/permission danger-full-access');
      await waitFor('permission changed', text => text.includes('permission → danger-full-access'));

      await enter('/fork');
      await waitFor('forked session active', text => /(created|resumed) [0-9a-f-]{12} · mode dscode/.test(text));
    }
    console.log('TUI_RUNNER_PROBE_PASSED ' + scenario);
    await enter('/quit');
  })().catch(error => { console.error(error.stack ?? error); fail(); });
}

export function apply(ctx) {
  runProbe(() => { const exit = ctx.get('appExit'); if (typeof exit === 'function') exit(1); else process.exit(1); });
}
