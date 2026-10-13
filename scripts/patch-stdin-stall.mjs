import { replaceOnce } from './patch-util.mjs';

// Legacy anchors let an already patched local installation migrate without
// reinstalling dependencies. New commands receive EOF unless they supply input;
// a terminal readiness hint alone never proves the wrapped command finished.
export const STDIN_STALL_MS = 5e3;
export const STDIN_STALL_NOTE = '\n[Interrupted after ' + STDIN_STALL_MS / 1e3 + 's with no output: the command held the terminal without producing anything, and this tool cannot supply terminal input. Give it stdin (a heredoc, `< file` or `< /dev/null`) or use a non-interactive form.]';

const STALL_BLOCK = [
  '\t\t\tconst partial = renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);',
  '\t\t\tif (result.waitReason === "stdin_read") stdinWaited = true;',
  '\t\t\tif (result.waitReason === "stdin_read" && partial.length > 0) return partial;',
  '\t\t\tif (stdinWaited && partial.length === 0 && !stdinStalled && Date.now() - startedAt >= STDIN_STALL_MS) {',
  '\t\t\t\tstdinStalled = true;',
  '\t\t\t\ttry {',
  '\t\t\t\t\tawait ctx.terminals.signal(owner, id, "SIGINT");',
  '\t\t\t\t} catch (_unsignallableForeground) {',
  '\t\t\t\t\tstdinStalled = false;',
  '\t\t\t\t\treturn partial;',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t\tawait pause();',
].join('\n');

const PREVIOUS_TAIL = '\t\t\tif (result.waitReason === "stdin_read") return renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);\n\t\t\tawait pause();';

export function patchStdinStall(text) {
  const marker = '// dscode-noninteractive-bash-v1';
  if (text.includes(marker)) return text;
  const captured = value => text.includes('// dscode-shell-capture-v1')
    ? value.replaceAll('retainedScrollback(ctx, owner, id, latest)', 'captured') : value;
  if (text.includes('// dscode-stdin-stall-v2') || text.includes('// dscode-stdin-stall-v1')) {
    if (text.includes('// dscode-stdin-stall-v2')) {
      text = replaceOnce(text, '// dscode-stdin-stall-v2\nconst STDIN_STALL_MS = ' + STDIN_STALL_MS + ';\nconst STDIN_STALL_NOTE = ' + JSON.stringify(STDIN_STALL_NOTE) + ';\n', '');
    } else text = replaceOnce(text, '// dscode-stdin-stall-v1\n', '');
    text = replaceOnce(text, '\t\tconst startedAt = Date.now();\n\t\tlet stdinWaited = false;\n\t\tlet stdinStalled = false;\n', '');
    text = replaceOnce(text, 'renderCaptured(complete, config.maxOutputChars) + (stdinStalled ? STDIN_STALL_NOTE : "")', 'renderCaptured(complete, config.maxOutputChars)');
    text = replaceOnce(text, captured(STALL_BLOCK), '\t\t\tawait pause();');
  } else {
    text = replaceOnce(text, captured(PREVIOUS_TAIL), '\t\t\tawait pause();');
  }
  text = replaceOnce(text, 'eval -- ${quoteForBash(command)};', 'eval -- ${quoteForBash(command)} < /dev/null;');
  return marker + '\n' + text;
}
