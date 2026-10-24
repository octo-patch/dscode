const signature = element => JSON.stringify(Object.fromEntries(Object.entries(element).filter(([key]) => key !== 'targetHandle')));

/** Full state stays in the Service; only the model-facing projection is compact.
 * Unchanged indexes can be used with the new observation id. Handles are valid
 * only on the exact observation which emitted them. */
export class ObservationProjection {
  states = new WeakMap();
  project(agent, observation, full = false) {
    let states = this.states.get(agent);
    if (!states) this.states.set(agent, states = new Map());
    const key = `${observation.app.bundleId}:${observation.app.pid}:${observation.scopeId ?? 'full'}`;
    const previous = states.get(key);
    const rows = new Map(observation.elements.map(element => [element.index, signature(element)]));
    states.delete(key); states.set(key, { id: observation.observationId, rows });
    while (states.size > 16) states.delete(states.keys().next().value);
    if (full || !previous || observation.tree.mode === 'full') return { ...observation, elementsMode: 'full' };
    return { ...observation, elementsMode: 'diff', baseObservationId: previous.id,
      removedElementIndexes: [...previous.rows.keys()].filter(index => !rows.has(index)),
      elements: observation.elements.filter(element => previous.rows.get(element.index) !== rows.get(element.index)),
      targetNote: 'Apply this diff to baseObservationId. Use current observationId with elementIndex for retained rows; never reuse an old targetHandle with a new observationId.' };
  }
}
