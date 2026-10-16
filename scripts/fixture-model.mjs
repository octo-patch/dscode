// Deterministic model for verification scripts (verify-local-carrier,
// verify-tui-runner). Provider `fixture` streams text in several deltas, and
// markers in the last user message drive interactive paths: APPROVE asks to
// write outside the workspace with escalation, so an approval must be decided;
// ASK calls ask_user_question; SLOW streams until the turn is cancelled;
// INSTRUCTIONS reports which workspace instruction markers reached its system
// prompt; LONG [KB] [FAST] streams a long Markdown reply (60 KB by default,
// paced unless FAST); TOOL lists the workspace with glob; ASKMANY asks three
// questions (single choice, multi-select, free text); PLAN presents a plan
// with exit_plan_mode (in plan mode). After a tool result it reports that result.
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
// A Markdown document of about `bytes` bytes that cycles through what replies
// contain: headings, CJK and Latin paragraphs, lists, code blocks and tables.
export function longMarkdown(bytes) {
  const sections = [
    i => `## ${i}. 第 ${i} 节：流式渲染\n\n这一段是中文正文，用来检查 CJK 文本在流式输出时的换行、字形和选择。模型每次只发出几个字符，客户端需要在不卡顿的情况下增量解析 Markdown。\n`,
    i => `The client folds **section ${i}** as it streams: \`TextView\` appends the delta, the parser extends the document, and [the list](https://example.com/${i}) remeasures the last row.\n`,
    i => `- item ${i}.1 with \`inline code\`\n- item ${i}.2, *emphasis* and **strong**\n  - nested ${i}.2.1\n- item ${i}.3\n`,
    i => '```rust\n' + `fn section_${i}(rows: &[Row]) -> usize {\n    rows.iter().filter(|row| row.visible).map(|row| row.height as usize).sum()\n}\n` + '```\n',
    i => `| Column | Value ${i} | Note |\n|---|---:|---|\n| alpha | ${i * 3} | 第一行 |\n| beta | ${i * 7} | second row |\n| gamma | ${i * 11} | third |\n`,
    i => '```typescript\n' + `export async function load${i}(socket: string): Promise<number> {\n  const rows = await fetchRows(socket, { page: ${i} });\n  return rows.length;\n}\n` + '```\n',
  ];
  let text = '';
  for (let i = 0; text.length < bytes; i++) text += sections[i % sections.length](Math.floor(i / sections.length) + 1) + '\n';
  return text;
}

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
      // Reminders the Host appends after a tool result are not a new prompt.
      const last = options.messages.findLast(m => !(m.role === 'user' && injected.test(textOf(m).trimStart())));
      if (last?.role === 'tool') return yield* text(`Tool finished: ${(last.content ?? []).map(b => b.text ?? '').join(' ').slice(0, 160)}`);
      const prompt = lastUser(options.messages);
      if (prompt.includes('APPROVE')) {
        return yield* call('write', { file_path: process.env.FIXTURE_OUTSIDE_PATH, content: 'written after approval\n',
          sandbox_permissions: 'danger-full-access', justification: 'Fixture verification asks for one decision.' });
      }
      if (prompt.includes('INSTRUCTIONS')) {
        const system = JSON.stringify(options.system ?? '') + JSON.stringify(options.messages);
        const seen = [...new Set(system.match(/MARKER_[A-Z]+/g) ?? [])].sort();
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
      if (prompt.includes('LONG')) {
        const kb = Number(prompt.match(/LONG\s+(\d+)/)?.[1] ?? 60);
        const pause = prompt.includes('FAST') ? 0 : 4;
        const value = longMarkdown(kb * 1024);
        yield { type: 'block-start', index: 0, blockType: 'text' };
        for (const part of value.match(/[^]{1,16}/g)) {
          if (options.signal?.aborted) throw options.signal.reason ?? new Error('aborted');
          if (pause) await new Promise(resolve => setTimeout(resolve, pause));
          yield { type: 'text-delta', index: 0, text: part };
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: value } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (prompt.includes('TOOL')) return yield* call('glob', { pattern: '*' });
      if (prompt.includes('ASKMANY')) {
        return yield* call('ask_user_question', { questions: [
          { id: 'color', header: 'Color', question: 'Which color should the fixture use?', options: [{ label: 'Blue (Recommended)', description: 'Matches the theme.' }, { label: 'Red', description: 'Stands out.' }] },
          { id: 'checks', header: 'Checks', question: 'Which checks should run?', multi_select: true, options: [{ label: 'Lint' }, { label: 'Unit tests' }, { label: '集成测试' }] },
          { id: 'name', question: 'What should the branch be called?' },
        ] });
      }
      if (prompt.includes('PLAN')) {
        return yield* call('exit_plan_mode', { plan: '# Fixture plan\n\n1. Read the code.\n2. Change `transcript.rs`.\n3. Run the tests.\n\n| Step | Risk |\n|---|---|\n| 1 | low |\n| 2 | medium |\n' });
      }
      if (prompt.includes('ASK')) {
        return yield* call('ask_user_question', { questions: [{ id: 'color', question: 'Which color should the fixture use?', header: 'Color', options: [{ label: 'Blue' }, { label: 'Red' }] }] });
      }
      yield* text(`${REPLY} (${options.model})`);
    }
  }
  ctx.llm.registerAdapter(['fixture'], new Adapter());
}
