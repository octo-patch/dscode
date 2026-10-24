import { FsError } from '@deepseek-ai/dsh-fs';

// These self-contained functions are embedded into the pinned runtime by
// patch-file-io.mjs. Keep their dependencies explicit or local to each function.
export function applyBatchEdits(content, edits, displayPath) {
  if (!Array.isArray(edits) || edits.length === 0 || edits.length > 100) {
    throw new FsError('edits must contain between 1 and 100 replacements', 'FS_EDIT_NOT_FOUND');
  }
  const matches = edits.map((edit, index) => {
    if (typeof edit?.oldString !== 'string' || typeof edit?.newString !== 'string') {
      throw new FsError(`edit ${index + 1} requires old_string and new_string`, 'FS_EDIT_NOT_FOUND');
    }
    const oldText = edit.oldString.replaceAll('\r\n', '\n');
    const newText = edit.newString.replaceAll('\r\n', '\n');
    if (!oldText || oldText === newText) throw new FsError(`edit ${index + 1} must change non-empty text`, 'FS_EDIT_NOT_FOUND');
    const start = content.indexOf(oldText);
    if (start < 0) throw new FsError(`edit ${index + 1}: text not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND');
    if (content.indexOf(oldText, start + 1) >= 0) throw new FsError(`edit ${index + 1}: text is not unique in "${displayPath}"`, 'FS_AMBIGUOUS_EDIT');
    return { start, end: start + oldText.length, newText };
  }).sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start < cursor) throw new FsError('edits overlap; combine changes to the same block', 'FS_AMBIGUOUS_EDIT');
    parts.push(content.slice(cursor, match.start), match.newText);
    cursor = match.end;
  }
  parts.push(content.slice(cursor));
  return { content: parts.join('') };
}

/** Bounded decoded-line scan; stopping iteration closes the provider's stream. */
export async function readWindow(chunks, request, displayPath) {
  const lines = [];
  let totalLines = 0, outputBytes = 0, line = '', truncatedByBytes = false;
  const bufferCap = request.maxLineLength + 1;
  const full = () => lines.length >= request.limit || truncatedByBytes;
  const append = segment => { line += segment.slice(0, Math.max(0, bufferCap - line.length)); };
  const flush = () => {
    totalLines++;
    if (totalLines >= request.offset) {
      const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
      const text = raw.length > request.maxLineLength
        ? `${raw.slice(0, request.maxLineLength)}... (line truncated to ${request.maxLineLength} chars)` : raw;
      const bytes = Buffer.byteLength(text) + (lines.length ? 1 : 0);
      if (outputBytes + bytes > request.maxBytes) truncatedByBytes = true;
      else { lines.push({ number: totalLines, text }); outputBytes += bytes; }
    }
    line = '';
  };
  for await (const chunk of chunks) {
    let start = 0;
    while (start < chunk.length) {
      // One character of lookahead proves there is more; do not count the tail.
      if (full()) return { lines, hasMore: true, truncatedByBytes };
      const end = chunk.indexOf('\n', start);
      if (end < 0) { append(chunk.slice(start)); break; }
      append(chunk.slice(start, end));
      flush();
      if (truncatedByBytes) return { lines, hasMore: true, truncatedByBytes };
      start = end + 1;
    }
  }
  if (line.length) flush();
  if (truncatedByBytes) return { lines, totalLines, hasMore: true, truncatedByBytes };
  if (request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${totalLines} lines)`, 'FS_NOT_FOUND');
  }
  return { lines, totalLines, hasMore: false, truncatedByBytes };
}

/** Session-owned LRU: cache only bounded pages, never whole files or observations. */
export function createReadWindowCache(maxBytes = 1024 * 1024, maxEntries = 32) {
  const owners = new WeakMap();
  return {
    get(owner, key) {
      const entries = owner && owners.get(owner);
      const item = entries?.get(key);
      if (!item) return undefined;
      entries.delete(key);
      entries.set(key, item);
      return structuredClone(item.value);
    },
    set(owner, key, value) {
      if (!owner) return;
      let entries = owners.get(owner);
      if (!entries) owners.set(owner, entries = new Map());
      const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value));
      if (bytes > maxBytes) return;
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), bytes });
      let size = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0);
      while (entries.size > maxEntries || size > maxBytes) {
        const oldest = entries.keys().next().value;
        size -= entries.get(oldest).bytes;
        entries.delete(oldest);
      }
    },
  };
}
