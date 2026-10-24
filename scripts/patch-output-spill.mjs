import { replaceOnce } from './patch-util.mjs';
import { spillCaptured } from './output-spill.mjs';

// Run after the capture and noninteractive-shell patches. Terminal capture is
// bounded at 4 MiB; never describe a truncated capture as a complete command log.
export function patchPersistentSpill(text) {
  const marker = '// dscode-persistent-spill-v1';
  if (text.includes(marker)) return text;
  const sites = [
    'renderCaptured(partialOutput(snapshot, marker, fallback, fallbackTruncated), config.maxOutputChars)',
    'renderCaptured(partialOutput(captured, marker, fallback, fallbackTruncated), config.maxOutputChars)',
    'renderCaptured(complete, config.maxOutputChars)',
  ];
  for (const call of sites) {
    text = replaceOnce(text, call, 'await spillCaptured(ctx, owner, ' + call.slice('renderCaptured('.length, -1) + ', renderCaptured)');
  }
  return marker + '\n' + spillCaptured.toString() + '\n' + text;
}
