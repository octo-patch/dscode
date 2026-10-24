import { replaceOnce } from './patch-util.mjs';
import { applyBatchEdits, readWindow, createReadWindowCache } from './file-io.mjs';

export function patchLocalFileIO(text) {
  const marker = '// dscode-batch-edit-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, 'async editText(target, edit, expected, signal) {', 'get supportsBatchEdit() { return true; }\n\tasync editText(target, edit, expected, signal) {');
  text = replaceOnce(text,
    'const edited = applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath);',
    'const edited = edit.edits !== undefined ? applyBatchEdits(original.content, edit.edits, target.displayPath) : applyLiteralEdit(original.content, edit.oldString, edit.newString, edit.replaceAll, target.displayPath);');
  return marker + '\n' + applyBatchEdits.toString() + '\n' + text;
}

export function patchFileTools(text) {
  const marker = '// dscode-file-tools-v1';
  if (text.includes(marker)) return text;
  // Register a second instance of the existing edit implementation. Both tools
  // retain the same sandbox, observation, diff presentation and CAS path.
  text = replaceOnce(text, 'function applyEditTool(ctx, sandbox) {', 'function applyEditTool(ctx, sandbox, many = false) {');
  text = replaceOnce(text, 'name: "tool:edit",', 'name: many ? "tool:edit_many" : "tool:edit",');
  text = replaceOnce(text, 'name: "edit",', 'name: many ? "edit_many" : "edit",');
  text = replaceOnce(text, 'description: "Edit an existing UTF-8 text file by replacing literal text.",',
    'description: many ? "Apply 1-100 unique, non-overlapping literal replacements to one file in a single guarded write. All matches refer to the original file. Read first; combine nearby edits. Prefer this over repeated edit calls." : "Edit an existing UTF-8 text file by replacing literal text.",');
  const start = text.indexOf('\n\t\t\told_string: {', text.indexOf('function applyEditTool'));
  const end = text.indexOf('\n\t\t\t...sandbox.escalationModes', start);
  if (start < 0 || end < 0) throw Error('Pinned runtime patch drift: edit parameters');
  text = text.slice(0, start) + '\n\t\t\t...(many ? { edits: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { old_string: { type: "string", required: true }, new_string: { type: "string", required: true } } } } } : {' + text.slice(start, end) + '\n\t\t\t}),' + text.slice(end);
  text = replaceOnce(text, 'const input = parseEditArgs(args);', `const input = many ? {
        filePath: args.file_path,
        edits: args.edits.map(edit => { const parsed = parseEditArgs({ ...edit, file_path: args.file_path }); return { oldString: parsed.oldString, newString: parsed.newString }; })
      } : parseEditArgs(args);`);
  text = replaceOnce(text, 'sandbox.resolvePolicy("edit", args, exec)', 'sandbox.resolvePolicy(many ? "edit_many" : "edit", args, exec)');
  text = replaceOnce(text, 'oldString: input.oldString,', '...(many ? { edits: input.edits } : {}),\n\t\t\t\t\toldString: input.oldString,');
  text = replaceOnce(text, 'diffs: [{\n\t\t\t\t\tpath: args.file_path,\n\t\t\t\t\toldText: args.old_string || null,\n\t\t\t\t\tnewText: args.new_string\n\t\t\t\t}],',
    'diffs: (many ? args.edits : [args]).map(edit => ({ path: args.file_path, oldText: edit.old_string || null, newText: edit.new_string })),');
  text = replaceOnce(text, 'if (resolved.edit) applyEditTool(ctx, sandbox);', 'if (resolved.edit) { applyEditTool(ctx, sandbox); if (ctx.fs.supportsBatchEdit === true) applyEditTool(ctx, sandbox, true); }');
  // Keep exact totals only when EOF was reached. Older read-card validators
  // gracefully use generic text for partial pages without an exact total.
  text = replaceOnce(text, 'function applyReadTool(ctx, caps) {', 'function applyReadTool(ctx, caps) {\n\tconst pageCache = createReadWindowCache();');
  text = replaceOnce(text, 'totalLines: {\n\t\t\t\t\t\ttype: "integer",\n\t\t\t\t\t\trequired: true\n\t\t\t\t\t}',
    'totalLines: { type: "integer", description: "Exact count only when EOF was scanned." },\n\t\t\t\t\thasMore: { type: "boolean", required: true }');
  text = replaceOnce(text, 'if (outcome.truncatedByBytes) footer =', 'if (outcome.hasMore && outcome.totalLines === undefined) footer = `(Showing lines ${outcome.offset}-${endLine}; more content remains. Use offset=${endLine + 1} to continue.)`;\n\telse if (outcome.truncatedByBytes) footer =');
  text = replaceOnce(text, 'totalLines: value.totalLines,\n\t\t\t\t\t\t...truncatedByBytes', 'totalLines: value.totalLines,\n\t\t\t\t\t\thasMore: value.hasMore,\n\t\t\t\t\t\t...truncatedByBytes');
  text = replaceOnce(text, 'totalLines: value.totalLines,\n\t\t\t\t\t...lang', '...(value.totalLines === undefined ? {} : { totalLines: value.totalLines }),\n\t\t\t\t\thasMore: value.hasMore,\n\t\t\t\t\t...lang');
  const old = `const window = await buildWindow(info.size === void 0 || info.size >= caps.streamMinSize ? await ctx.fs.streamText(target, exec.signal) : [await ctx.fs.readText(target, exec.signal)], {
\t\t\t\toffset: input.offset,
\t\t\t\tlimit: input.limit,
\t\t\t\tmaxLineLength: caps.maxLineLength,
\t\t\t\tmaxBytes: caps.maxBytes
\t\t\t}, target.displayPath);`;
  text = replaceOnce(text, old, `const request = { offset: input.offset, limit: input.limit, maxLineLength: caps.maxLineLength, maxBytes: caps.maxBytes };
      const owner = exec.agent?.session;
      const cacheKey = JSON.stringify([target.targetKey, info.version, request]);
      exec.signal?.throwIfAborted();
      const window = (info.version !== undefined ? pageCache.get(owner, cacheKey) : undefined)
        ?? await readWindow(await ctx.fs.streamText(target, exec.signal), request, target.displayPath);
      const after = await ctx.fs.stat(target, exec.signal);
      if (!after || after.version !== info.version) throw new FsError('File changed while reading; read it again', 'FS_STALE_VERSION');
      if (info.version !== undefined) pageCache.set(owner, cacheKey, window);`);
  text = replaceOnce(text, 'totalLines: window.totalLines\n\t\t\t};', '...(window.totalLines === undefined ? {} : { totalLines: window.totalLines }),\n\t\t\t\thasMore: window.hasMore\n\t\t\t};');
  return marker + '\n' + readWindow.toString() + '\n' + createReadWindowCache.toString() + '\n' + text;
}
