import { replaceOnce } from './patch-util.mjs';

export function patchAcpStatus(text) {
  const marker = '// dscode-acp-status-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, '\t\t\t\tconst content = await admitAcpPrompt(this.ctx, promptSelection, params.prompt, imageEnabled, admissionController.signal);', `
        const status = await this.ctx.dscodeAcpStatus?.(promptSelection, params.prompt, admissionController.signal);
        if (status !== undefined) {
          admissionController.signal.throwIfAborted();
          await this.notify({ sessionId: this.agent.session.id, update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "dscode-status-" + randomUUID(),
            content: { type: "text", text: status }
          } });
          inflight.endReason = { kind: "completed" };
          inflight.finishAdmission();
          this.settleAfterQuiescence(inflight);
          return { stopReason: await completion.promise };
        }
        const content = await admitAcpPrompt(this.ctx, promptSelection, params.prompt, imageEnabled, admissionController.signal);`);
  text = replaceOnce(text, '\tconfigOptions(signal) {', '\tasync configOptions(signal) {');
  text = replaceOnce(text, '\t\treturn this.modelControl.options(signal);', `
    if (this.ctx.dscodeAcpStatus) await this.notify({ sessionId: this.agent.session.id, update: { sessionUpdate: "available_commands_update", availableCommands: [
      { name: "status", description: "Show the current provider, model and available balance" }
    ] } });
    return this.modelControl.options(signal);`);
  return marker + '\n' + text;
}
