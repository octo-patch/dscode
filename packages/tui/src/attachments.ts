/** Terminal image- and file-attachment adapter over the Harness durable attachment service. */

import { open, readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, extname, isAbsolute, resolve } from 'node:path'
import type { AttachmentStore, ImageMediaType, SaveFileAttachment, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'

/** A validated path retained in the editor until submission persists it. */
export interface ImagePathInspection {
  readonly path: string
  readonly name: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
}

/** A validated non-image file path retained the same way (0.1.5 file blocks). */
export interface FilePathInspection {
  readonly path: string
  readonly name: string
  readonly bytes: number
}

/**
 * Terminal-side file admission bounds. Upstream exposes image limits through
 * the attachment service but no file limits (files ride verbatim storage);
 * these keep a dragged file from silently ingesting a disk-sized blob and
 * bound one message the way the image batch is bounded.
 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES_PER_MESSAGE = 8

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

/** Detect the supported encoded raster formats from bytes, never from a path suffix. */
export function detectImageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a) return 'image/png'
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 6) {
    const signature = String.fromCharCode(...data.subarray(0, 6))
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif'
  }
  if (data.length >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}

/** Whether a path-like token is worth probing as an image attachment. */
export function looksLikeImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase())
}

/**
 * Parse a paste/drop into its image and file paths: image-suffixed tokens
 * stay images, other path-shaped tokens ride as file attachments (0.1.5
 * file blocks), and anything that is neither leaves both empty — the caller
 * then treats the paste as plain text.
 *
 * File tokens are held to an absolute-path-with-shape bar (drive/backslash
 * or a dot-suffixed leaf after a separator): a dropped terminal path always
 * carries one of those, while prose, slash commands, and option flags never
 * do. A POSIX absolute path without any dot-suffixed leaf falls through as
 * text — the @ mention route still attaches such files deliberately.
 */
export function parsePastedAttachmentPaths(input: string): { readonly images: readonly string[]; readonly files: readonly string[] } {
  const text = input.trim()
  if (text === '') return { images: [], files: [] }
  const images: string[] = []
  const files: string[] = []
  const looksLikeDroppedFile = (path: string): boolean =>
    /^[A-Za-z]:[\\/]/u.test(path)
    || /^\\\\/u.test(path)
    || (/^\/|^\.\.?\//u.test(path) && /\.[A-Za-z0-9]{1,16}$/u.test(path))
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/gu
  for (const match of text.matchAll(matcher)) {
    const token = match[1] ?? match[2] ?? match[3]
    if (token === undefined) continue
    let path = token
    if (path.startsWith('file://')) {
      try {
        path = fileURLToPath(path)
      } catch {
        return { images: [], files: [] }
      }
      if (looksLikeImagePath(path)) images.push(path)
      else files.push(path)
      continue
    }
    if (looksLikeImagePath(path)) {
      images.push(path)
      continue
    }
    if (!looksLikeDroppedFile(path)) return { images: [], files: [] }
    files.push(path)
  }
  return { images, files }
}

/**
 * Facts read from one image the Host may not be able to see: a remote
 * terminal reads them locally and the Host checks them against its limits.
 */
export interface ImageFacts {
  readonly path: string
  readonly name: string
  readonly bytes: number
  /** The file's leading bytes (at least 16), enough to recognize its format. */
  readonly signature: Uint8Array
}

/** Facts read from one non-image file, checked the same way. */
export interface FileFacts {
  readonly path: string
  readonly name: string
  readonly bytes: number
}

/** One attachment sent as content rather than as a path. */
export interface AttachmentData {
  readonly name: string
  readonly data: Uint8Array
}

/** Check image facts against the store's count, size and format limits. */
export function inspectImageFacts(facts: readonly ImageFacts[], attachments: AttachmentStore | undefined): readonly ImagePathInspection[] {
  if (facts.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  if (facts.length > attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`too many images (${facts.length}; limit ${attachments.imageLimits.maxImagesPerMessage})`)
  }
  let totalBytes = 0
  return facts.map(fact => {
    if (fact.bytes > attachments.imageLimits.maxImageBytes) {
      throw new Error(`image "${fact.name}" is ${fact.bytes} bytes; limit ${attachments.imageLimits.maxImageBytes}`)
    }
    totalBytes += fact.bytes
    if (totalBytes > attachments.imageLimits.maxMessageImageBytes) {
      throw new Error(`image batch is ${totalBytes} bytes; limit ${attachments.imageLimits.maxMessageImageBytes}`)
    }
    const mediaType = detectImageMediaType(fact.signature)
    if (mediaType === undefined || !attachments.imageLimits.mediaTypes.includes(mediaType)) {
      throw new Error(`unsupported image file "${fact.path}" (expected PNG, JPEG, WebP, or GIF)`)
    }
    return { path: fact.path, name: fact.name, mediaType, bytes: fact.bytes }
  })
}

/** Check non-image file facts against the per-message count and per-file size. */
export function inspectFileFacts(facts: readonly FileFacts[], attachments: AttachmentStore | undefined): readonly FilePathInspection[] {
  if (facts.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  if (facts.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`too many files (${facts.length}; limit ${MAX_FILES_PER_MESSAGE})`)
  }
  return facts.map(fact => {
    if (fact.bytes > MAX_FILE_BYTES) throw new Error(`file "${fact.name}" is ${fact.bytes} bytes; limit ${MAX_FILE_BYTES}`)
    return { path: fact.path, name: fact.name, bytes: fact.bytes }
  })
}

/** Stat one local path for inspection; `signature` also reads its leading bytes. */
export async function readPathFacts(raw: string, cwd: string, kind: 'image' | 'file'): Promise<ImageFacts> {
  const path = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  let facts: Awaited<ReturnType<typeof stat>>
  try {
    facts = await stat(path)
  } catch (error: unknown) {
    throw new Error(`cannot read ${kind} "${raw}": ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!facts.isFile()) throw new Error(`${kind} path is not a file: "${raw}"`)
  const signature = new Uint8Array(16)
  let bytesRead = 0
  if (kind === 'image') {
    const handle = await open(path, 'r')
    try {
      bytesRead = (await handle.read(signature, 0, signature.length, 0)).bytesRead
    } finally {
      await handle.close()
    }
  }
  return { path, name: basename(path), bytes: facts.size, signature: signature.subarray(0, bytesRead) }
}

/** Validate path, byte size and encoded signature without writing an attachment object. */
export async function inspectImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  cwd = process.cwd(),
): Promise<readonly ImagePathInspection[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  // The count bound is checked before any file is opened.
  if (paths.length > attachments.imageLimits.maxImagesPerMessage) {
    throw new Error(`too many images (${paths.length}; limit ${attachments.imageLimits.maxImagesPerMessage})`)
  }
  const facts: ImageFacts[] = []
  for (const raw of paths) facts.push(await readPathFacts(raw, cwd, 'image'))
  return inspectImageFacts(facts, attachments)
}

/** Read, validate, and persist an ordered image path list as model content blocks. */
export async function saveImagePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly ImageBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  const items: AttachmentData[] = []
  for (const path of paths) {
    if (signal?.aborted === true) throw new Error('image submission cancelled')
    try {
      items.push({ name: basename(path), data: await readFile(path) })
    } catch (error: unknown) {
      throw new Error(`cannot read image "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return saveImageData(items, attachments, signal)
}

/** Validate and persist images sent as content (a remote terminal's local files). */
export async function saveImageData(
  items: readonly AttachmentData[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly ImageBlock[]> {
  if (items.length === 0) return []
  if (attachments === undefined) throw new Error('image attachments are unavailable in this profile')
  const checkCancelled = (): void => {
    if (signal?.aborted === true) throw new Error('image submission cancelled')
  }
  const inputs: SaveImageAttachment[] = []
  for (const item of items) {
    checkCancelled()
    const mediaType = detectImageMediaType(item.data)
    if (mediaType === undefined) throw new Error(`unsupported image file "${item.name}" (expected PNG, JPEG, WebP, or GIF)`)
    inputs.push({ data: item.data, mediaType, name: item.name })
  }
  checkCancelled()
  const refs = await attachments.saveImages(inputs)
  checkCancelled()
  return refs.map(attachment => ({ type: 'image', attachment }))
}

/** Validate path and byte size for non-image file attachments without writing. */
export async function inspectFilePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  cwd = process.cwd(),
): Promise<readonly FilePathInspection[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  if (paths.length > MAX_FILES_PER_MESSAGE) {
    throw new Error(`too many files (${paths.length}; limit ${MAX_FILES_PER_MESSAGE})`)
  }
  const facts: FileFacts[] = []
  for (const raw of paths) facts.push(await readPathFacts(raw, cwd, 'file'))
  return inspectFileFacts(facts, attachments)
}

/** Read and persist an ordered non-image file path list as model file blocks. */
export async function saveFilePaths(
  paths: readonly string[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly FileBlock[]> {
  if (paths.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  // The bounds are re-checked here so a draft inspected earlier still guards
  // the actual read at submission time.
  await inspectFilePaths(paths, attachments)
  const items: AttachmentData[] = []
  for (const path of paths) {
    if (signal?.aborted === true) throw new Error('file submission cancelled')
    try {
      items.push({ name: basename(path), data: await readFile(path) })
    } catch (error: unknown) {
      throw new Error(`cannot read file "${path}": ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return saveFileData(items, attachments, signal)
}

/** Validate and persist non-image files sent as content. */
export async function saveFileData(
  items: readonly AttachmentData[],
  attachments: AttachmentStore | undefined,
  signal?: AbortSignal,
): Promise<readonly FileBlock[]> {
  if (items.length === 0) return []
  if (attachments === undefined) throw new Error('file attachments are unavailable in this profile')
  inspectFileFacts(items.map(item => ({ path: item.name, name: item.name, bytes: item.data.byteLength })), attachments)
  const checkCancelled = (): void => {
    if (signal?.aborted === true) throw new Error('file submission cancelled')
  }
  checkCancelled()
  const refs = await Promise.all(items.map(item => attachments.saveFile({ data: item.data, name: item.name } satisfies SaveFileAttachment)))
  checkCancelled()
  return refs.map(attachment => ({ type: 'file', attachment }))
}
