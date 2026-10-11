// The TUI's explicit picker choice takes precedence over its last request header.
// Keep the live ref outside model history; WeakMap ownership follows the Agent.
const selections = new WeakMap();
export const registerStatusSelection = (agent, read) => { selections.set(agent, read); };
export const statusSelection = agent => selections.get(agent)?.()
  ?? { ...agent.options, ...agent.session.requestHeader()?.config };
