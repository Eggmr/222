/**
 * Shared file, text and naming helpers for the novel memory plugin.
 *
 * Everything here is dependency-free so the memory format can be tested
 * without a running DeepSeek Harness instance.
 *
 * @module dsh-novel-memory/lib/util
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

/** @returns {string} current time in ISO-8601. */
export function nowIso() {
  return new Date().toISOString()
}

/**
 * @param {string} text
 * @returns {string} hex SHA-256.
 */
export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/**
 * @param {string} text
 * @returns {string} first 12 hex characters.
 */
export function shortHash(text) {
  return sha256(text).slice(0, 12)
}

/**
 * Turn a human name/title into a stable, cross-platform file name stem.
 * Unicode letters are preserved, so Chinese character names stay readable.
 *
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(value, fallback = 'item') {
  const source = String(value ?? '').normalize('NFKC').trim()
  let slug = source
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._ ]+|[-._ ]+$/g, '')
  slug = Array.from(slug).slice(0, 64).join('')
  if (slug === '') slug = fallback + '-' + shortHash(source).slice(0, 8)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(slug)) slug = '_' + slug
  return slug
}

/**
 * Normalize a name for matching (ignores spaces and punctuation).
 *
 * @param {string} value
 * @returns {string}
 */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Return a unique id based on `base`, adding -2, -3... when needed.
 *
 * @param {string} base
 * @param {Iterable<string>} used
 * @returns {string}
 */
export function uniqueId(base, used) {
  const taken = new Set(used)
  let id = base
  let n = 2
  while (taken.has(id)) {
    id = base + '-' + n
    n += 1
  }
  return id
}

/**
 * Approximate word count: one CJK character counts as one word, one Latin
 * word/number group counts as one word. Good enough for progress display.
 *
 * @param {string} text
 * @returns {number}
 */
export function countWords(text) {
  const source = String(text ?? '')
  const cjk = source.match(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g)?.length ?? 0
  const latin = source.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0
  return cjk + latin
}

/**
 * Truncate text with an explicit marker.
 *
 * @param {string} text
 * @param {number} max
 * @param {{ tail?: boolean }} [options]
 * @returns {string}
 */
export function truncateText(text, max, options = {}) {
  const source = String(text ?? '')
  const limit = Math.max(0, Math.floor(max))
  if (source.length <= limit) return source
  if (limit === 0) return ''
  if (options.tail) {
    return '……（前文略）\n' + source.slice(-limit)
  }
  return source.slice(0, limit) + '\n……（后文略）'
}

/**
 * Return a short excerpt around the first case-insensitive occurrence.
 *
 * @param {string} text
 * @param {string} query
 * @param {number} [radius]
 * @returns {string}
 */
export function snippetAround(text, query, radius = 50) {
  const source = String(text ?? '')
  const needle = String(query ?? '')
  if (needle === '') return source.slice(0, radius * 2)
  const index = source.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase())
  if (index < 0) return source.slice(0, radius * 2)
  const start = Math.max(0, index - radius)
  const end = Math.min(source.length, index + needle.length + radius)
  return (start > 0 ? '…' : '') + source.slice(start, end).replace(/\s+/g, ' ') + (end < source.length ? '…' : '')
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Whether `target` is inside `root` (or equal to it).
 *
 * @param {string} root
 * @param {string} target
 * @returns {boolean}
 */
export function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Convert a platform path to a stable forward-slash relative path.
 *
 * @param {string} value
 * @returns {string}
 */
export function toPosixPath(value) {
  return String(value).split(path.sep).join('/')
}

/**
 * @param {string} file
 * @returns {Promise<boolean>}
 */
export async function exists(file) {
  try {
    await access(file, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Atomically replace a UTF-8 text file. The temp file lives in the target
 * directory so the final rename stays on one volume.
 *
 * @param {string} file
 * @param {string} content
 * @returns {Promise<void>}
 */
export async function atomicWriteFile(file, content) {
  await ensureDir(path.dirname(file))
  const tmp = file + '.tmp-' + process.pid + '-' + randomBytes(5).toString('hex')
  await writeFile(tmp, String(content), 'utf8')
  try {
    await rename(tmp, file)
  } catch (error) {
    // Windows can refuse rename-over-existing; fall back to unlink + rename.
    if (error && (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES')) {
      await rm(file, { force: true })
      await rename(tmp, file)
      return
    }
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * @param {string} file
 * @param {unknown} value
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(file, value) {
  await atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n')
}

/**
 * @param {string} file
 * @returns {Promise<any | null>}
 */
export async function readJsonIfExists(file) {
  try {
    return await readJson(file)
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
export async function readJson(file) {
  const text = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '')
  return JSON.parse(text)
}

/**
 * @param {string} file
 * @returns {Promise<string | null>}
 */
export async function readTextIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null
    throw error
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
export async function listDir(dir) {
  try {
    return await readdir(dir)
  } catch (error) {
    if (error && error.code === 'ENOENT') return []
    throw error
  }
}

/**
 * @param {string} dir
 * @param {string} [suffix]
 * @returns {Promise<string[]>}
 */
export async function listFiles(dir, suffix = '') {
  const entries = await listDir(dir)
  return entries
    .filter((entry) => suffix === '' || entry.endsWith(suffix))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

/**
 * @param {string} file
 * @returns {Promise<number | null>}
 */
export async function mtimeMs(file) {
  try {
    return (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

/**
 * @param {string} file
 * @returns {Promise<void>}
 */
export async function removeFile(file) {
  await rm(file, { force: true })
}

/**
 * @param {string} value
 * @returns {string}
 */
export function escapeMarkdownCell(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>')
}

/**
 * @param {number} number
 * @returns {string}
 */
export function pad4(number) {
  return String(Math.max(0, Math.trunc(number))).padStart(4, '0')
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(label + ' 不能为空')
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function stringArray(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

/**
 * @param {unknown} value
 * @returns {Record<string, any>}
 */
export function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

/**
 * Deterministic JSON used by the audit ledger hash chain.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}'
}
