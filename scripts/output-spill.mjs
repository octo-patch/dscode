/** Persist the captured result before the persistent shell's inline truncation. */
export async function spillCaptured(ctx, owner, output, maxOutputChars, render) {
  const preview = render(output, maxOutputChars);
  if (output.text.length <= maxOutputChars) return preview;
  try {
    const store = ctx.get?.('spillStore');
    const sessionId = owner?.session?.header?.id;
    if (!store || sessionId === undefined) throw Error('spill storage or session owner unavailable');
    const ref = await store.saveText({
      owner: { sessionId },
      source: { kind: 'tool', toolName: 'bash', label: 'captured command output' },
      suggestedName: 'bash-output.txt',
      content: (output.exitCode === undefined ? '[Partial capture: command completion was not observed.]\n' : '') + render(output, Number.MAX_SAFE_INTEGER),
    });
    const label = output.incomplete ? 'Captured output (earlier bytes were lost)' : output.exitCode === undefined ? 'Partial captured output' : 'Full captured output';
    return `${preview}\n[${label}: ${ref.locator}. ${ref.retrievalHint}]`;
  } catch (error) {
    ctx.logger?.warn?.(`Could not save command output: ${error.message}`);
    return `${preview}\n[Output could not be saved for retrieval; use command-level redirection to retain it.]`;
  }
}
