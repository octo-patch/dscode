// Deterministic model for verification scripts (verify-local-carrier,
// verify-tui-runner). Provider `fixture` streams text in several deltas, and
// markers in the last user message drive interactive paths: APPROVE asks to
// write outside the workspace with escalation, so an approval must be decided;
// ASK calls ask_user_question; SLOW streams until the turn is cancelled;
// INSTRUCTIONS reports which workspace instruction markers reached its system
// prompt. After a tool result it reports that result.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'fixture-model';
export const inject = ['llm'];
export const REPLY = 'Streaming through the fixture works.';
const textOf = message => (message?.content ?? []).map(b => b.text ?? '').join('');
// Context providers append reminders after the typed message (workspace
// instructions, runtime context, skills, time marks); the prompt is the last
// user message that is none of those.
const injected = /^(<system-reminder>|Current runtime context|Time (mark|sampled))/;
const lastUser = messages => textOf(messages.findLast(m => m.role === 'user' && !injected.test(textOf(m).trimStart())));
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    providerInfo(provider) { return { id: provider, name: 'Fixture' }; }
    async listModels(provider) { return [{ provider, id: 'fixture', name: 'Fixture' }, { provider, id: 'fixture-b', name: 'Fixture B' }]; }
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const text = async function* (value) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const part of value.match(/.{1,4}/gs)) yield { type: 'text-delta', index: 0, text: part };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
        yield { type: 'finish', reason: { kind: 'stop' } };
      };
      const call = async function* (name, args) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `call-${name}`, name, arguments: JSON.stringify(args) } };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      };
      if (options.purpose) return yield* text('Fixture title');
      const last = options.messages.at(-1);
      if (last?.role === 'tool') return yield* text(`Tool finished: ${(last.content ?? []).map(b => b.text ?? '').join(' ').slice(0, 160)}`);
      const prompt = lastUser(options.messages);
      if (prompt.includes('APPROVE')) {
        return yield* call('write', { file_path: process.env.FIXTURE_OUTSIDE_PATH, content: 'written after approval\n',
          sandbox_permissions: 'danger-full-access', justification: 'Fixture verification asks for one decision.' });
      }
      if (prompt.includes('INSTRUCTIONS')) {
        const system = JSON.stringify(options.system ?? '') + JSON.stringify(options.messages);
        const seen = ['MARKER_ALPHA', 'MARKER_BETA'].filter(marker => system.includes(marker));
        return yield* text(`instructions:[${seen.join(',')}]`);
      }
      if (prompt.includes('SLOW')) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'Working slowly' };
        // Stream nothing more until the turn is interrupted.
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60000);
          options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason ?? new Error('aborted')); }, { once: true });
        });
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Working slowly' } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (prompt.includes('ASK')) {
        return yield* call('ask_user_question', { questions: [{ id: 'color', question: 'Which color should the fixture use?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }] }] });
      }
      yield* text(`${REPLY} (${options.model})`);
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
}
