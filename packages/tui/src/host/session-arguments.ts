/** Runtime validation for the DSCODE session extensions (Typert validates its own methods). */
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value)
const id = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f]/.test(value)
const text = (value: unknown): boolean => typeof value === 'string'
const optionalId = (value: unknown): boolean => value === undefined || id(value)
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) > 0

function content(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(block => {
    if (!object(block)) return false
    if (block.type === 'text') return text(block.text)
    if (block.type !== 'file' && block.type !== 'image') return false
    const ref = block.attachment
    if (!object(ref) || !id(ref.attachmentId) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) return false
    if (block.type === 'file') return id(ref.name)
    return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType) && positive(ref.width) && positive(ref.height)
  }) && value.some(block => block.type !== 'text' || block.text.trim() !== '')
}

/** Undefined means valid or outside this extension's vocabulary. */
export function sessionArgumentError(name: string, args: unknown): string | undefined {
  const rules: Record<string, (a: Record<string, any>) => boolean> = {
    'session/deliver': a => id(a.sessionId) && content(a.content) && ['followup', 'steer'].includes(a.mode) && optionalId(a.requestId)
      && (a.context === undefined || (object(a.context) && a.context.role === 'user' && id(a.context.id) && content(a.context.content) && object(a.context.source) && id(a.context.source.kind))),
    'session/updateQueued': a => id(a.sessionId) && id(a.messageId) && object(a.action)
      && (['remove', 'steer'].includes(a.action.kind) || (a.action.kind === 'edit' && text(a.action.text))),
    'session/interrupt': a => id(a.sessionId) && (a.expectedTurnSeq === undefined || (Number.isSafeInteger(a.expectedTurnSeq) && a.expectedTurnSeq >= 0)),
    'sessions/delete': a => id(a.id) && optionalId(a.currentId),
    'sessions/transcript': a => id(a.id),
    'sessions/search': a => text(a.query),
    'sessions/usage': a => optionalId(a.sessionId),
    'sessions/rename': a => id(a.sessionId) && typeof a.title === 'string' && a.title.trim().length > 0,
    'sessions/resolveResume': a => id(a.wanted) && optionalId(a.currentId) && (a.allowLive === undefined || typeof a.allowLive === 'boolean'),
    'sessions/subagents': a => id(a.sessionId) && text(a.cwd),
    'sessions/children': a => id(a.sessionId),
    'sessions/list': a => object(a.options) && ['roots', 'all'].includes(a.options.sessions)
      && ['all', 'current'].includes(a.options.cwd) && ['newest', 'oldest'].includes(a.options.sort)
      && text(a.options.currentCwd) && text(a.options.query),
  }
  const rule = rules[name]
  return rule === undefined || (object(args) && rule(args)) ? undefined : `invalid arguments for ${name}`
}
