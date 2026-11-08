/**
 * Memory-root paths, state normalization, workspace binding, locking and
 * crash-safe multi-file writes.
 *
 * @module dsh-novel-memory/lib/store
 */

import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import {
  exists,
  ensureDir,
  atomicWriteFile,
  readJson,
  readJsonIfExists,
  readTextIfExists,
  removeFile,
  sha256,
  sleep,
  stableStringify,
  nowIso,
  slugify,
  stringArray,
  plainObject,
  clampInt,
  mtimeMs,
  listDir,
} from './util.js'

export const MEMORY_KIND = 'dsh-novel-memory'
export const STATE_KIND = 'dsh-novel-memory-state'
export const SCHEMA_VERSION = 1
export const BINDING_FILE = '.dsh-novel.json'
export const INTERNAL_DIR = '.novel-memory'
export const DEFAULT_MAX_CONTEXT_CHARS = 30000

/**
 * @param {string} root
 * @returns {Record<string, string>}
 */
export function memoryPaths(root) {
  const memoryDir = path.resolve(root)
  const internal = path.join(memoryDir, INTERNAL_DIR)
  return {
    root: memoryDir,
    project: path.join(memoryDir, 'project.json'),
    state: path.join(memoryDir, 'state', 'current.json'),
    readme: path.join(memoryDir, 'README.md'),
    characters: path.join(memoryDir, 'characters'),
    world: path.join(memoryDir, 'world'),
    plot: path.join(memoryDir, 'plot'),
    arcs: path.join(memoryDir, 'plot', 'arcs'),
    chapters: path.join(memoryDir, 'chapters'),
    history: path.join(memoryDir, 'history'),
    commits: path.join(memoryDir, 'history', 'commits'),
    rolledBack: path.join(memoryDir, 'history', 'rolled-back'),
    internal,
    ledger: path.join(internal, 'ledger.jsonl'),
    journal: path.join(internal, 'journal.json'),
    lock: path.join(internal, 'lock'),
  }
}

/**
 * @param {string} memoryDir
 * @returns {boolean}
 */
export async function isMemoryRoot(memoryDir) {
  try {
    const project = await readJson(path.join(path.resolve(memoryDir), 'project.json'))
    return project?.kind === MEMORY_KIND
  } catch {
    return false
  }
}

/**
 * @param {string} value
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolvePath(value, cwd = process.cwd()) {
  return path.resolve(cwd, String(value ?? '').trim())
}

/**
 * The initial project descriptor.
 *
 * @param {{ title?: string, genre?: string, language?: string, style?: string, synopsis?: string }} [input]
 * @returns {Record<string, any>}
 */
export function createProject(input = {}) {
  const now = nowIso()
  return {
    kind: MEMORY_KIND,
    schemaVersion: SCHEMA_VERSION,
    pluginVersion: '0.1.0',
    title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '未命名小说',
    genre: typeof input.genre === 'string' && input.genre.trim() ? input.genre.trim() : '',
    language: typeof input.language === 'string' && input.language.trim() ? input.language.trim() : 'zh-CN',
    style: typeof input.style === 'string' && input.style.trim() ? input.style.trim() : '',
    synopsis: typeof input.synopsis === 'string' && input.synopsis.trim() ? input.synopsis.trim() : '',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * The initial story state. `main` is the default worldline/arc.
 *
 * @returns {Record<string, any>}
 */
export function emptyState() {
  return {
    kind: STATE_KIND,
    schemaVersion: SCHEMA_VERSION,
    characters: {},
    world: {
      overview: '',
      rules: [],
      locations: [],
      factions: [],
      items: [],
    },
    arcs: {
      main: {
        id: 'main',
        name: '主线',
        status: '进行中',
        startChapter: 1,
        endChapter: null,
        summary: '故事主线。',
        chapters: [],
        updatedAt: nowIso(),
      },
    },
    threads: [],
    foreshadowing: [],
    timeline: [],
    chapters: [],
    nextHooks: [],
    progress: {
      lastChapter: 0,
      lastChapterTitle: null,
      totalWords: 0,
      timelinePosition: '故事开始前',
      lastCommitAt: null,
      lastCommitHash: null,
    },
  }
}

/**
 * Normalize loaded state in place and fill historical gaps.
 *
 * @param {any} input
 * @returns {Record<string, any>}
 */
export function normalizeState(input) {
  const state = plainObject(input)
  state.kind = STATE_KIND
  state.schemaVersion = SCHEMA_VERSION
  state.characters = plainObject(state.characters)
  state.world = Object.assign({ overview: '', rules: [], locations: [], factions: [], items: [] }, plainObject(state.world))
  state.world.rules = Array.isArray(state.world.rules) ? state.world.rules : []
  state.world.locations = Array.isArray(state.world.locations) ? state.world.locations : []
  state.world.factions = Array.isArray(state.world.factions) ? state.world.factions : []
  state.world.items = Array.isArray(state.world.items) ? state.world.items : []
  state.arcs = plainObject(state.arcs)
  state.threads = Array.isArray(state.threads) ? state.threads : []
  state.foreshadowing = Array.isArray(state.foreshadowing) ? state.foreshadowing : []
  state.timeline = Array.isArray(state.timeline) ? state.timeline : []
  state.chapters = Array.isArray(state.chapters) ? state.chapters : []
  state.nextHooks = stringArray(state.nextHooks)
  state.progress = Object.assign(
    {
      lastChapter: 0,
      lastChapterTitle: null,
      totalWords: 0,
      timelinePosition: '故事开始前',
      lastCommitAt: null,
      lastCommitHash: null,
    },
    plainObject(state.progress),
  )
  state.progress.lastChapter = clampInt(state.progress.lastChapter, 0, 0, 1_000_000)
  state.progress.totalWords = clampInt(state.progress.totalWords, 0, 0, 1_000_000_000)
  state.progress.timelinePosition =
    typeof state.progress.timelinePosition === 'string' ? state.progress.timelinePosition : '故事开始前'
  state.progress.lastChapterTitle =
    typeof state.progress.lastChapterTitle === 'string' ? state.progress.lastChapterTitle : null

  for (const [key, raw] of Object.entries(state.characters)) {
    const character = plainObject(raw)
    character.id = typeof character.id === 'string' && character.id ? character.id : key
    character.name = typeof character.name === 'string' && character.name ? character.name : character.id
    character.aliases = stringArray(character.aliases)
    character.role = typeof character.role === 'string' ? character.role : '配角'
    character.status = typeof character.status === 'string' ? character.status : '未知'
    character.location = typeof character.location === 'string' ? character.location : ''
    character.mood = typeof character.mood === 'string' ? character.mood : ''
    character.profile = Object.assign(
      { personality: '', appearance: '', background: '', motivation: '', abilities: '', arc: '' },
      plainObject(character.profile),
    )
    character.relationships = Array.isArray(character.relationships)
      ? character.relationships.filter((item) => item && typeof item === 'object' && typeof item.target === 'string')
      : []
    character.experiences = Array.isArray(character.experiences)
      ? character.experiences.filter((item) => item && typeof item === 'object' && typeof item.text === 'string')
      : []
    character.notes = typeof character.notes === 'string' ? character.notes : ''
    character.firstChapter = clampInt(character.firstChapter, 1, 1, 1_000_000)
    character.lastChapter = clampInt(character.lastChapter, 1, 1, 1_000_000)
    character.updatedAt = typeof character.updatedAt === 'string' ? character.updatedAt : nowIso()
    state.characters[key] = character
  }

  for (const [key, raw] of Object.entries(state.arcs)) {
    const arc = plainObject(raw)
    arc.id = typeof arc.id === 'string' && arc.id ? arc.id : key
    arc.name = typeof arc.name === 'string' && arc.name ? arc.name : arc.id
    arc.status = typeof arc.status === 'string' && arc.status ? arc.status : '进行中'
    arc.startChapter = clampInt(arc.startChapter, 1, 1, 1_000_000)
    arc.endChapter = arc.endChapter == null ? null : clampInt(arc.endChapter, arc.startChapter, 1, 1_000_000)
    arc.summary = typeof arc.summary === 'string' ? arc.summary : ''
    arc.chapters = Array.isArray(arc.chapters)
      ? [...new Set(arc.chapters.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
      : []
    arc.updatedAt = typeof arc.updatedAt === 'string' ? arc.updatedAt : nowIso()
    state.arcs[key] = arc
  }

  state.threads = state.threads
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : slugify(item.title ?? 'thread'),
      title: typeof item.title === 'string' ? item.title : '未命名线索',
      status: item.status === 'closed' || item.status === '已回收' ? 'closed' : 'open',
      description: typeof item.description === 'string' ? item.description : '',
      relatedCharacters: stringArray(item.relatedCharacters),
      plantedChapter: clampInt(item.plantedChapter, 1, 1, 1_000_000),
      resolvedChapter: item.resolvedChapter == null ? null : clampInt(item.resolvedChapter, 1, 1, 1_000_000),
      resolution: typeof item.resolution === 'string' ? item.resolution : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
    }))

  state.foreshadowing = state.foreshadowing
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' && item.id ? item.id : slugify(item.text ?? 'foreshadowing'),
      text: typeof item.text === 'string' ? item.text : '',
      status: item.status === 'paid-off' || item.status === '已回收' ? 'paid-off' : item.status === 'abandoned' ? 'abandoned' : 'planted',
      plantedChapter: clampInt(item.plantedChapter, 1, 1, 1_000_000),
      payoffChapter: item.payoffChapter == null ? null : clampInt(item.payoffChapter, 1, 1, 1_000_000),
      payoff: typeof item.payoff === 'string' ? item.payoff : '',
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
    }))

  state.timeline = state.timeline
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      chapter: clampInt(item.chapter, 1, 1, 1_000_000),
      time: typeof item.time === 'string' ? item.time : '',
      location: typeof item.location === 'string' ? item.location : '',
      characters: stringArray(item.characters),
      event: typeof item.event === 'string' ? item.event : '',
      consequences: typeof item.consequences === 'string' ? item.consequences : '',
    }))

  state.chapters = state.chapters
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      number: clampInt(item.number, 1, 1, 1_000_000),
      title: typeof item.title === 'string' ? item.title : '未命名章节',
      file: typeof item.file === 'string' ? item.file : '',
      summary: typeof item.summary === 'string' ? item.summary : '',
      wordCount: clampInt(item.wordCount, 0, 0, 100_000_000),
      hash: typeof item.hash === 'string' ? item.hash : '',
      committedAt: typeof item.committedAt === 'string' ? item.committedAt : nowIso(),
    }))
    .sort((a, b) => a.number - b.number)

  return state
}

/**
 * @param {string} memoryDir
 * @returns {Promise<Record<string, any>>}
 */
export async function readProjectUnlocked(memoryDir) {
  const project = await readJson(memoryPaths(memoryDir).project)
  if (project?.kind !== MEMORY_KIND) {
    throw new Error('目标目录不是 dsh-novel-memory 记忆库：' + memoryDir)
  }
  if (project.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('不支持的记忆库版本：' + String(project.schemaVersion))
  }
  project.title = typeof project.title === 'string' && project.title ? project.title : '未命名小说'
  project.language = typeof project.language === 'string' && project.language ? project.language : 'zh-CN'
  project.createdAt = typeof project.createdAt === 'string' ? project.createdAt : nowIso()
  project.updatedAt = typeof project.updatedAt === 'string' ? project.updatedAt : project.createdAt
  return project
}

/**
 * @param {string} memoryDir
 * @returns {Promise<Record<string, any>>}
 */
export async function readStateUnlocked(memoryDir) {
  const state = normalizeState(await readJson(memoryPaths(memoryDir).state))
  if (state.kind !== STATE_KIND) {
    throw new Error('记忆库状态文件损坏：state/current.json')
  }
  return state
}

/**
 * Read without taking the lock. The caller must already hold it.
 *
 * @param {string} memoryDir
 * @returns {Promise<{ memoryDir: string, project: any, state: any, paths: Record<string, string> }>}
 */
export async function loadMemoryUnlocked(memoryDir) {
  const root = path.resolve(memoryDir)
  const project = await readProjectUnlocked(root)
  const state = await readStateUnlocked(root)
  return { memoryDir: root, project, state, paths: memoryPaths(root) }
}

/**
 * Read with the memory lock; also finishes a crashed commit first.
 *
 * @param {string} memoryDir
 * @returns {Promise<{ memoryDir: string, project: any, state: any, paths: Record<string, string> }>}
 */
export async function loadMemory(memoryDir) {
  const root = path.resolve(memoryDir)
  return withLock(root, () => loadMemoryUnlocked(root))
}

/**
 * Workspace binding file: remembers which memory folder this novel workspace
 * uses, so tools can omit `memoryDir` after the first init/use.
 *
 * @param {string} cwd
 * @returns {Promise<{ memoryDir: string, title?: string, boundAt?: string } | null>}
 */
export async function readBinding(cwd) {
  const candidates = [
    path.join(cwd, BINDING_FILE),
    path.join(cwd, '.dsh', 'novel-memory.json'),
  ]
  for (const file of candidates) {
    const raw = await readJsonIfExists(file)
    if (raw?.kind !== 'dsh-novel-memory-binding' || typeof raw.memoryDir !== 'string' || raw.memoryDir.trim() === '') {
      continue
    }
    return {
      memoryDir: resolvePath(raw.memoryDir, cwd),
      title: typeof raw.title === 'string' ? raw.title : undefined,
      boundAt: typeof raw.boundAt === 'string' ? raw.boundAt : undefined,
    }
  }
  return null
}

/**
 * @param {string} cwd
 * @param {string} memoryDir
 * @param {string} [title]
 * @returns {Promise<string>}
 */
export async function bindWorkspace(cwd, memoryDir, title) {
  const file = path.join(cwd, BINDING_FILE)
  await atomicWriteFile(
    file,
    JSON.stringify(
      {
        kind: 'dsh-novel-memory-binding',
        memoryDir: path.resolve(memoryDir),
        title: title ?? null,
        boundAt: nowIso(),
      },
      null,
      2,
    ) + '\n',
  )
  return file
}

/**
 * Resolve the active memory folder from an explicit argument, plugin config,
 * environment variable, workspace binding, or the cwd itself.
 *
 * @param {{ memoryDir?: string, cwd?: string, config?: Record<string, any> }} input
 * @returns {Promise<{ memoryDir: string, source: string }>}
 */
export async function resolveMemoryDir(input = {}) {
  const cwd = input.cwd || process.cwd()
  const config = plainObject(input.config)
  /** @type {Array<{ value: string, source: string, required: boolean }>} */
  const candidates = []

  if (typeof input.memoryDir === 'string' && input.memoryDir.trim() !== '') {
    candidates.push({ value: input.memoryDir, source: 'memoryDir 参数', required: true })
  }
  if (typeof config.memoryDir === 'string' && config.memoryDir.trim() !== '') {
    candidates.push({ value: config.memoryDir, source: '插件配置 memoryDir', required: true })
  }
  if (typeof process.env.DSH_NOVEL_MEMORY === 'string' && process.env.DSH_NOVEL_MEMORY.trim() !== '') {
    candidates.push({ value: process.env.DSH_NOVEL_MEMORY, source: '环境变量 DSH_NOVEL_MEMORY', required: true })
  }
  const binding = await readBinding(cwd)
  if (binding) {
    candidates.push({ value: binding.memoryDir, source: '工作区绑定 ' + BINDING_FILE, required: true })
  }
  candidates.push({ value: cwd, source: '当前工作区', required: false })

  for (const candidate of candidates) {
    const resolved = resolvePath(candidate.value, cwd)
    if (await isMemoryRoot(resolved)) {
      return { memoryDir: resolved, source: candidate.source }
    }
    if (candidate.required) {
      throw new Error(
        candidate.source + ' 指向的不是有效记忆库：' + resolved + '\n' +
          '请先调用 novel_init 初始化，或用 novel_use 改绑到已有记忆库。',
      )
    }
  }

  throw new Error(
    '还没有绑定小说记忆库。\n' +
      '先调用 novel_init 指定一个目录，例如：\n' +
      '  novel_init({ memoryDir: "D:\\\\小说\\\\我的作品-记忆库", title: "我的作品" })\n' +
      '已有记忆库则调用 novel_use({ memoryDir: "..." })。',
  )
}

/**
 * Acquire a cross-process lock directory. Stale locks from crashed processes
 * are reclaimed automatically.
 *
 * @template T
 * @param {string} memoryDir
 * @param {() => Promise<T>} fn
 * @param {{ waitMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withLock(memoryDir, fn, options = {}) {
  const root = path.resolve(memoryDir)
  const paths = memoryPaths(root)
  await ensureDir(paths.internal)
  const waitMs = clampInt(options.waitMs, 8000, 0, 120000)
  const started = Date.now()

  for (;;) {
    try {
      await mkdir(paths.lock)
      await atomicWriteFile(
        path.join(paths.lock, 'owner.json'),
        JSON.stringify({ pid: process.pid, startedAt: nowIso(), memoryDir: root }) + '\n',
      )
      break
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error
      if (await isStaleLock(paths.lock)) {
        await removeDir(paths.lock)
        continue
      }
      if (Date.now() - started >= waitMs) {
        throw new Error('记忆库正在被另一个操作写入，请稍后重试。')
      }
      await sleep(120)
    }
  }

  try {
    await recoverJournalUnlocked(root)
    return await fn()
  } finally {
    await removeDir(paths.lock)
  }
}

/**
 * @param {string} lockDir
 * @returns {Promise<boolean>}
 */
async function isStaleLock(lockDir) {
  const owner = await readJsonIfExists(path.join(lockDir, 'owner.json'))
  const age = Date.now() - ((await mtimeMs(lockDir)) ?? Date.now())
  if (!owner) return age > 30_000
  if (age > 10 * 60_000) return true
  const pid = Number(owner.pid)
  if (!Number.isInteger(pid) || pid <= 0) return age > 60_000
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists but belongs to another user; treat alive.
    return !error || error.code !== 'EPERM'
  }
}

/**
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function removeDir(dir) {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
}

/**
 * Apply a planned journal while already holding the lock. Idempotent: a
 * journal left by a crash is applied again on the next tool call.
 *
 * @param {string} memoryDir
 * @param {{ files?: Array<{ path: string, content: string }>, deletes?: string[], createdAt?: string, id?: string }} plan
 * @returns {Promise<{ files: string[], deletes: string[] }>}
 */
export async function applyPlanUnlocked(memoryDir, plan) {
  const root = path.resolve(memoryDir)
  const paths = memoryPaths(root)
  const files = normalizePlanFiles(root, plan.files)
  const deletes = normalizeDeletes(root, plan.deletes)
  const journal = {
    version: 1,
    id: plan.id || sha256(String(Date.now()) + Math.random()).slice(0, 16),
    createdAt: plan.createdAt || nowIso(),
    files,
    deletes,
  }
  await ensureDir(paths.internal)
  await atomicWriteFile(paths.journal, JSON.stringify(journal) + '\n')
  await applyJournalUnlocked(root, journal)
  return { files: files.map((file) => file.path), deletes }
}

/**
 * @param {string} memoryDir
 * @param {{ files?: Array<{ path: string, content: string }>, deletes?: string[] }} plan
 * @returns {Promise<{ files: string[], deletes: string[] }>}
 */
export async function applyPlan(memoryDir, plan) {
  const root = path.resolve(memoryDir)
  return withLock(root, () => applyPlanUnlocked(root, plan))
}

/**
 * @param {string} root
 * @param {any} journal
 * @returns {Promise<void>}
 */
async function applyJournalUnlocked(root, journal) {
  const paths = memoryPaths(root)
  for (const file of normalizePlanFiles(root, journal.files)) {
    await atomicWriteFile(path.join(root, file.path), file.content)
  }
  for (const relative of normalizeDeletes(root, journal.deletes)) {
    await removeFile(path.join(root, relative))
  }
  await removeFile(paths.journal)
}

/**
 * @param {string} memoryDir
 * @returns {Promise<boolean>}
 */
async function recoverJournalUnlocked(memoryDir) {
  const paths = memoryPaths(memoryDir)
  if (!(await exists(paths.journal))) return false
  const journal = await readJson(paths.journal)
  if (journal?.version !== 1 || !Array.isArray(journal.files)) {
    throw new Error('记忆库 journal.json 损坏，已停止写入以免覆盖数据：' + paths.journal)
  }
  await applyJournalUnlocked(memoryDir, journal)
  return true
}

/**
 * @param {string} root
 * @param {unknown} value
 * @returns {Array<{ path: string, content: string }>}
 */
function normalizePlanFiles(root, value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      throw new Error('journal 文件条目格式错误')
    }
    const relative = normalizeRelativePath(entry.path)
    if (typeof entry.content !== 'string') {
      throw new Error('journal 文件内容必须是字符串：' + relative)
    }
    return { path: relative, content: entry.content }
  })
}

/**
 * Normalize a journal path and reject anything that escapes the memory root.
 * Both separators are treated as separators so a Windows-authored journal
 * cannot slip past validation on a POSIX host (or vice versa).
 *
 * @param {string} value
 * @returns {string}
 */
function normalizeRelativePath(value) {
  const unified = String(value).replace(/\\/g, '/')
  if (unified.startsWith('/') || /^[A-Za-z]:/.test(unified)) {
    throw new Error('journal 路径越界：' + value)
  }
  const normalized = path.posix.normalize(unified).replace(/^\.\//, '')
  if (normalized === '' || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error('journal 路径越界：' + value)
  }
  return normalized
}

/**
 * @param {string} root
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeDeletes(root, value) {
  if (!Array.isArray(value)) return []
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('journal 删除路径格式错误')
    return normalizeRelativePath(entry)
  })
}

/**
 * @param {string} memoryDir
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readLedger(memoryDir) {
  const text = await readTextIfExists(memoryPaths(memoryDir).ledger)
  if (!text) return []
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line)
      } catch {
        return { __corrupt: true, line: index + 1, raw: line }
      }
    })
}

/**
 * Build one hash-chained ledger entry.
 *
 * @param {{ seq: number, type?: string, chapter?: number | null, title?: string, contentHash?: string, stateHash?: string, prevHash?: string, [key: string]: any }} input
 * @returns {Record<string, any>}
 */
export function makeLedgerEntry(input) {
  const payload = {
    seq: Number(input.seq) || 1,
    time: input.time || nowIso(),
    type: input.type || 'commit',
    chapter: input.chapter ?? null,
    title: input.title ?? null,
    contentHash: input.contentHash ?? null,
    stateHash: input.stateHash ?? null,
    prevHash: input.prevHash ?? 'GENESIS',
  }
  for (const [key, value] of Object.entries(input)) {
    if (!(key in payload) && key !== 'hash') payload[key] = value
  }
  const hash = sha256(stableStringify(payload))
  return { ...payload, hash }
}

/**
 * @param {Array<Record<string, any>>} entries
 * @param {Record<string, any>} entry
 * @returns {string}
 */
export function serializeLedger(entries, entry) {
  const lines = entries.filter((item) => !item.__corrupt).map((item) => JSON.stringify(item))
  lines.push(JSON.stringify(entry))
  return lines.join('\n') + '\n'
}

/**
 * @param {string} memoryDir
 * @returns {Promise<Array<{ name: string, dir: string, meta: any }>>}
 */
export async function listCommitDirs(memoryDir) {
  const dir = memoryPaths(memoryDir).commits
  const names = (await listDir(dir)).filter((name) => /^\d+-ch-\d+$/.test(name)).sort()
  const result = []
  for (const name of names) {
    const full = path.join(dir, name)
    const meta = await readJsonIfExists(path.join(full, 'meta.json'))
    if (meta) result.push({ name, dir: full, meta })
  }
  return result
}
