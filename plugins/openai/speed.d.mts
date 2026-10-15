/** Speed display shared with the terminal; implementation lives in speed.mjs. */
export function speedLabel(sessionId: string, modelLabel?: string): string;
/** Install the per-session speed reader; returns a disposer that removes it if still installed. */
export declare function setSpeedSource(next: (sessionId: string, modelLabel: string) => string | undefined): () => void;
