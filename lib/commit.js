/**
 * Build and apply one novel commit: append the chapter, merge structured
 * changes, rebuild all Markdown views and append a hash-chained ledger entry.
 *
 * The commit is planned entirely in memory first, then written through the
 * journal in `store.js`, so a crash cannot leave a half-updated memory folder.
 *
 * @module dsh-novel-memory/lib/commit
 */

import path from 'node:path'
import {
  countWords,
  exists,
  nowIso,
  pad4,
  plainObject,
  requireText,
  sha256,
  slugify,
  stableStringify,
  stringArray,
  truncateText,
  uniqueId,
  normalizeName,
} from './util.js'
import {
  applyPlanUnlocked,
  loadMemoryUnlocked,
  makeLedgerEntry,
  readLedger,
  serializeLedger,
  withLock,
} from './store.js'
import { chapterFileRelative, renderChapterFile, renderMarkdownFiles } from './render.js'

/**
 * Commit a chapter.
 *
 * @param {{ memoryDir: string, args: Record<string, any>, config?: Record<string, any> }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function commitChapter(input) {
  const root = path.resolve(input.memoryDir)
  return withLock(root, async () => {
    const memory = await loadMemoryUnlocked(root)
    const plan = await buildCommitPlan({
      memoryDir: root,
      project: memory.project,
      state: memory.state,
      args: input.args,
    })
    if (plan.alreadyCommitted || input.args?.dryRun === true) {
      return plan.result
    }
    await applyPlanUnlocked(root, { files: plan.files, deletes: [] })
    return plan.result
  })
}

/**
 * Plan a commit without writing. Exported for tests and dry-run.
 *
 * @param {{ memoryDir: string, project: Record<string, any>, state: Record<string, any>, args: Record<string, any> }} input
 * @returns {Promise<{ files?: Array<{ path: string, content: string }>, result: Record<string, any>, alreadyCommitted?: boolean }>}
 */
export async function buildCommitPlan(input) {
  const root = path.resolve(input.memoryDir)
  const project = structuredClone(input.project)
  const state = structuredClone(input.state)
  const args = plainObject(input.args)
  const warnings = []

  const content = requireText(args.content, 'content（正文）')
  const summary = truncateText(requireText(args.summary, 'summary（本章摘要）'), 2000)
  const lastChapter = Number(state.progress.lastChapter) || 0
  const chapter = args.chapter == null ? lastChapter + 1 : Number(args.chapter)
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new Error('chapter 必须是大于 0 的整数')
  }
  if (chapter <= lastChapter) {
    const existing = state.chapters.find((item) => item.number === chapter)
    if (existing && existing.hash === sha256(content)) {
      return {
        alreadyCommitted: true,
        result: {
          alreadyCommitted: true,
          memoryDir: root,
          chapter,
          title: existing.title,
          summary: existing.summary,
          wordCount: existing.wordCount,
          contentHash: existing.hash,
          message: '这一章已经以完全相同的内容提交过，本次未做任何修改。',
          warnings: [],
          text: `第 ${chapter} 章已存在且内容哈希一致，本次提交是幂等的，没有重复写入。`,
        },
      }
    }
    throw new Error(
      `第 ${chapter} 章已经提交过（当前进度第 ${lastChapter} 章）。\n` +
        '如需重写最近章节，请先用 novel_rollback 回滚，再重新提交；不要直接覆盖旧章，否则时间线和人物经历会错乱。',
    )
  }
  if (chapter > lastChapter + 1) {
    if (args.allowGap !== true) {
      throw new Error(
        `章节号不连续：当前第 ${lastChapter} 章，准备提交第 ${chapter} 章。\n` +
          '如果确实要跳章，请显式传 allowGap: true。',
      )
    }
    warnings.push(`允许了跳章：从第 ${lastChapter} 章跳到第 ${chapter} 章。`)
  }

  const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : '未命名'
  const file = chapterFileRelative(chapter, title)
  if (await exists(path.join(root, file))) {
    throw new Error('章节文件已存在：' + file + '\n请先回滚或换一个章节号。')
  }

  const contentHash = sha256(content)
  const wordCount = countWords(content)
  const committedAt = nowIso()
  const changes = plainObject(args.changes)

  // Cards, worldlines and threads are merged before the chapter index so the
  // context pack sees a coherent state on the next turn.
  applyTimeline(state, changes.timeline, chapter, summary)
  applyCharacters(state, changes.characters, chapter, warnings)
  applyWorld(state, changes.world, chapter)
  applyArcs(state, changes.arcs, chapter)
  ensureActiveArc(state, chapter)
  applyThreads(state, changes.threads, chapter)
  applyForeshadowing(state, changes.foreshadowing, chapter)

  const nextHooks = Array.isArray(args.nextHooks) ? stringArray(args.nextHooks) : []
  if (nextHooks.length === 0) {
    warnings.push('没有提供 nextHooks：下一章开头可能缺少明确的悬念钩子。')
  }
  state.nextHooks = nextHooks

  if (typeof args.timelinePosition === 'string' && args.timelinePosition.trim() !== '') {
    state.progress.timelinePosition = args.timelinePosition.trim()
  }

  if (summary.length < 40) {
    warnings.push('summary 偏短（少于 40 字），下一轮上下文可能缺少本章关键因果。')
  }
  if (!Array.isArray(changes.characters) || changes.characters.length === 0) {
    warnings.push('本章没有登记任何人物状态变化；如果正文里人物有行动/情绪/关系变化，建议补充。')
  }
  if (!Array.isArray(changes.timeline) || changes.timeline.length === 0) {
    warnings.push('本章没有登记 timeline 事件，已用 summary 自动补一条通用事件。')
  }

  const chapterMeta = {
    number: chapter,
    title,
    file,
    summary,
    wordCount,
    hash: contentHash,
    committedAt,
  }
  state.chapters.push(chapterMeta)
  state.chapters.sort((a, b) => a.number - b.number)
  state.progress.lastChapter = chapter
  state.progress.lastChapterTitle = title
  state.progress.totalWords = state.chapters.reduce((sum, item) => sum + (Number(item.wordCount) || 0), 0)
  state.progress.lastCommitAt = committedAt
  state.progress.lastCommitHash = contentHash

  project.updatedAt = committedAt
  const stateHash = sha256(stableStringify(state))

  const ledgerEntries = await readLedger(root)
  const corrupt = ledgerEntries.find((entry) => entry.__corrupt)
  if (corrupt) {
    throw new Error(
      `审计日志 .novel-memory/ledger.jsonl 第 ${corrupt.line} 行无法解析，已停止提交以免破坏哈希链。` +
        '请先修复或备份该文件。',
    )
  }
  const prevHash = ledgerEntries.length ? String(ledgerEntries[ledgerEntries.length - 1].hash ?? 'GENESIS') : 'GENESIS'
  const ledgerEntry = makeLedgerEntry({
    seq: ledgerEntries.length + 1,
    type: 'commit',
    chapter,
    title,
    contentHash,
    stateHash,
    prevHash,
    summary,
  })
  const ledgerText = serializeLedger(ledgerEntries, ledgerEntry)

  const markdownFiles = renderMarkdownFiles(state, project)
  const seqName = String(ledgerEntry.seq).padStart(6, '0') + '-ch-' + pad4(chapter)
  const historyDir = 'history/commits/' + seqName
  const files = [
    { path: 'project.json', content: JSON.stringify(project, null, 2) + '\n' },
    { path: 'state/current.json', content: JSON.stringify(state, null, 2) + '\n' },
    ...markdownFiles,
    { path: file, content: renderChapterFile({ ...chapterMeta, content }) },
    {
      path: historyDir + '/before-state.json',
      content: JSON.stringify(input.state, null, 2) + '\n',
    },
    {
      path: historyDir + '/before-project.json',
      content: JSON.stringify(input.project, null, 2) + '\n',
    },
    {
      path: historyDir + '/meta.json',
      content:
        JSON.stringify(
          {
            seq: ledgerEntry.seq,
            chapter,
            title,
            contentHash,
            stateHash,
            ledgerHash: ledgerEntry.hash,
            summary,
            timelinePosition: state.progress.timelinePosition,
            nextHooks,
            warnings,
            createdAt: committedAt,
          },
          null,
          2,
        ) + '\n',
    },
    { path: '.novel-memory/ledger.jsonl', content: ledgerText },
  ]

  const text = [
    `已提交第 ${chapter} 章《${title}》。`,
    `字数：${wordCount} ｜ 人物：${Object.keys(state.characters).length} ｜ 未回收线索：${state.threads.filter((t) => t.status === 'open').length}`,
    `内容哈希：${contentHash}`,
    `状态哈希：${stateHash}`,
    `账本序号：${ledgerEntry.seq}`,
    warnings.length ? '提醒：\n- ' + warnings.join('\n- ') : '记忆库已同步，下一轮可直接调用 novel_context。',
  ].join('\n')

  return {
    result: {
      alreadyCommitted: false,
      dryRun: args.dryRun === true,
      memoryDir: root,
      chapter,
      title,
      summary,
      wordCount,
      contentHash,
      stateHash,
      ledgerSeq: ledgerEntry.seq,
      ledgerHash: ledgerEntry.hash,
      filesWritten: files.map((item) => item.path),
      warnings,
      text,
    },
    files,
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawTimeline
 * @param {number} chapter
 * @param {string} summary
 */
function applyTimeline(state, rawTimeline, chapter, summary) {
  if (Array.isArray(rawTimeline)) {
    for (const raw of rawTimeline) {
      const event = plainObject(raw)
      const text = typeof event.event === 'string' ? event.event.trim() : ''
      if (text === '') continue
      const entry = {
        chapter,
        time: typeof event.time === 'string' ? event.time.trim() : '',
        location: typeof event.location === 'string' ? event.location.trim() : '',
        characters: stringArray(event.characters),
        event: text,
        consequences: typeof event.consequences === 'string' ? event.consequences.trim() : '',
      }
      const duplicate = state.timeline.some(
        (item) => item.chapter === chapter && normalizeName(item.event) === normalizeName(entry.event),
      )
      if (!duplicate) state.timeline.push(entry)
    }
  }
  if (!state.timeline.some((item) => item.chapter === chapter)) {
    state.timeline.push({
      chapter,
      time: '',
      location: '',
      characters: [],
      event: summary,
      consequences: '',
    })
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawCharacters
 * @param {number} chapter
 * @param {string[]} warnings
 */
function applyCharacters(state, rawCharacters, chapter, warnings) {
  if (!Array.isArray(rawCharacters)) return
  for (const raw of rawCharacters) {
    const update = plainObject(raw)
    const name = typeof update.name === 'string' ? update.name.trim() : ''
    if (name === '') {
      warnings.push('忽略了一条没有 name 的人物更新。')
      continue
    }
    const character = ensureCharacter(state, name, chapter, update.id)
    if (Array.isArray(update.aliases)) {
      character.aliases = [...new Set([...character.aliases, ...stringArray(update.aliases)])]
    }
    for (const key of ['role', 'status', 'location', 'mood']) {
      if (typeof update[key] === 'string' && update[key].trim() !== '') {
        character[key] = update[key].trim()
      }
    }
    if (typeof update.notes === 'string') {
      character.notes = update.notes.trim()
    }
    const profile = plainObject(update.profile)
    for (const key of ['personality', 'appearance', 'background', 'motivation', 'abilities', 'arc']) {
      if (typeof profile[key] === 'string' && profile[key].trim() !== '') {
        character.profile[key] = profile[key].trim()
      }
    }
    if (Array.isArray(update.relationships)) {
      for (const rawRelation of update.relationships) {
        const relation = plainObject(rawRelation)
        const targetRaw = typeof relation.target === 'string' ? relation.target.trim() : ''
        if (targetRaw === '') continue
        const target = findCharacter(state, targetRaw)
        const targetType = relation.targetType === 'other' ? 'other' : 'character'
        if (relation.remove === true) {
          const removeId = target ? target.id : targetRaw
          character.relationships = character.relationships.filter(
            (item) => item.target !== removeId && item.target !== targetRaw,
          )
          continue
        }
        let targetCharacter = target
        if (!targetCharacter && targetType === 'character' && relation.createTarget !== false) {
          targetCharacter = createCharacterStub(state, targetRaw, chapter)
        }
        const targetId = targetCharacter ? targetCharacter.id : targetRaw
        let existing = character.relationships.find(
          (item) => item.target === targetId || item.target === targetRaw,
        )
        if (!existing) {
          existing = { target: targetId, type: '', note: '', sinceChapter: chapter }
          character.relationships.push(existing)
        }
        if (typeof relation.type === 'string' && relation.type.trim() !== '') {
          existing.type = relation.type.trim()
        }
        if (typeof relation.note === 'string') {
          existing.note = relation.note.trim()
        }
        if (typeof relation.attitude === 'string') {
          existing.attitude = relation.attitude.trim()
        }
        if (!existing.sinceChapter) existing.sinceChapter = chapter
      }
    }
    if (Array.isArray(update.experiences)) {
      for (const rawExperience of update.experiences) {
        const text =
          typeof rawExperience === 'string'
            ? rawExperience.trim()
            : typeof plainObject(rawExperience).text === 'string'
              ? plainObject(rawExperience).text.trim()
              : ''
        if (text === '') continue
        const duplicate = character.experiences.some(
          (item) => item.chapter === chapter && normalizeName(item.text) === normalizeName(text),
        )
        if (!duplicate) character.experiences.push({ chapter, text })
      }
    }
    character.lastChapter = chapter
    character.updatedAt = nowIso()
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawWorld
 * @param {number} chapter
 */
function applyWorld(state, rawWorld, chapter) {
  const world = plainObject(rawWorld)
  if (!state.world.overview && typeof world.overview === 'string') {
    state.world.overview = world.overview.trim()
  } else if (typeof world.overview === 'string' && world.overview.trim() !== '') {
    state.world.overview = world.overview.trim()
  }
  applyWorldEntries(state, state.world.rules, world.rules, chapter, 'title')
  applyWorldEntries(state, state.world.locations, world.locations, chapter, 'name')
  applyWorldEntries(state, state.world.factions, world.factions, chapter, 'name')
  applyWorldEntries(state, state.world.items, world.items, chapter, 'name')
}

/**
 * @param {Record<string, any>} state
 * @param {Array<Record<string, any>>} target
 * @param {unknown} rawEntries
 * @param {number} chapter
 * @param {'name'|'title'} key
 */
function applyWorldEntries(state, target, rawEntries, chapter, key) {
  if (!Array.isArray(rawEntries)) return
  for (const raw of rawEntries) {
    const entry = plainObject(raw)
    const name = typeof entry[key] === 'string' ? entry[key].trim() : typeof entry.name === 'string' ? entry.name.trim() : ''
    if (name === '') continue
    const existing = target.find(
      (item) => normalizeName(item[key] ?? item.name ?? item.title) === normalizeName(name),
    )
    if (existing) {
      if (typeof entry.description === 'string' && entry.description.trim() !== '') {
        existing.description = entry.description.trim()
      }
      if (typeof entry.text === 'string' && entry.text.trim() !== '') {
        existing.text = entry.text.trim()
      }
      existing.updatedChapter = chapter
    } else {
      target.push({
        id: uniqueId(slugify(name, key), target.map((item) => item.id)),
        [key]: name,
        description: typeof entry.description === 'string' ? entry.description.trim() : '',
        text: typeof entry.text === 'string' ? entry.text.trim() : '',
        chapter,
        updatedChapter: chapter,
      })
    }
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawArcs
 * @param {number} chapter
 */
function applyArcs(state, rawArcs, chapter) {
  if (!Array.isArray(rawArcs)) return
  for (const raw of rawArcs) {
    const update = plainObject(raw)
    const name = typeof update.name === 'string' ? update.name.trim() : ''
    const id = typeof update.id === 'string' ? update.id.trim() : ''
    if (name === '' && id === '') continue
    let arc = Object.values(state.arcs).find(
      (item) => (id && item.id === id) || (name && normalizeName(item.name) === normalizeName(name)),
    )
    if (!arc) {
      const arcName = name || id
      arc = {
        id: uniqueId(slugify(id || arcName, 'arc'), Object.keys(state.arcs)),
        name: arcName,
        status: '进行中',
        startChapter: chapter,
        endChapter: null,
        summary: '',
        chapters: [],
        updatedAt: nowIso(),
      }
      state.arcs[arc.id] = arc
    }
    if (typeof update.name === 'string' && update.name.trim() !== '') arc.name = update.name.trim()
    if (typeof update.status === 'string' && update.status.trim() !== '') {
      arc.status = normalizeArcStatus(update.status)
    }
    if (typeof update.summary === 'string' && update.summary.trim() !== '') {
      arc.summary = update.summary.trim()
    }
    if (update.startChapter != null) arc.startChapter = Math.max(1, Math.trunc(Number(update.startChapter)) || chapter)
    if (update.endChapter != null) arc.endChapter = Math.max(1, Math.trunc(Number(update.endChapter)) || chapter)
    if (arc.status === '已完结' && arc.endChapter == null) arc.endChapter = chapter
    if (arc.status !== '未开始') {
      arc.chapters = [...new Set([...arc.chapters, chapter])].sort((a, b) => a - b)
    }
    arc.updatedAt = nowIso()
  }
}

/**
 * @param {Record<string, any>} state
 * @param {number} chapter
 */
function ensureActiveArc(state, chapter) {
  if (Object.keys(state.arcs).length === 0) {
    state.arcs.main = {
      id: 'main',
      name: '主线',
      status: '进行中',
      startChapter: 1,
      endChapter: null,
      summary: '故事主线。',
      chapters: [chapter],
      updatedAt: nowIso(),
    }
    return
  }
  let active = Object.values(state.arcs).filter((arc) => arc.status === '进行中')
  if (active.length === 0) {
    const name = '第 ' + chapter + ' 章起'
    const id = uniqueId(slugify(name, 'arc'), Object.keys(state.arcs))
    state.arcs[id] = {
      id,
      name,
      status: '进行中',
      startChapter: chapter,
      endChapter: null,
      summary: '',
      chapters: [chapter],
      updatedAt: nowIso(),
    }
    active = [state.arcs[id]]
  }
  for (const arc of active) {
    if (!arc.chapters.includes(chapter)) arc.chapters.push(chapter)
    arc.chapters.sort((a, b) => a - b)
    arc.updatedAt = nowIso()
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawThreads
 * @param {number} chapter
 */
function applyThreads(state, rawThreads, chapter) {
  if (!Array.isArray(rawThreads)) return
  for (const raw of rawThreads) {
    const update = plainObject(raw)
    const title = typeof update.title === 'string' ? update.title.trim() : ''
    const id = typeof update.id === 'string' ? update.id.trim() : ''
    if (title === '' && id === '') continue
    let thread = state.threads.find(
      (item) => (id && item.id === id) || (title && normalizeName(item.title) === normalizeName(title)),
    )
    if (!thread) {
      thread = {
        id: uniqueId(slugify(id || title, 'thread'), state.threads.map((item) => item.id)),
        title: title || id,
        status: 'open',
        description: '',
        relatedCharacters: [],
        plantedChapter: chapter,
        resolvedChapter: null,
        resolution: '',
        updatedAt: nowIso(),
      }
      state.threads.push(thread)
    }
    if (title !== '') thread.title = title
    if (typeof update.description === 'string') thread.description = update.description.trim()
    if (Array.isArray(update.relatedCharacters)) {
      thread.relatedCharacters = [...new Set([...thread.relatedCharacters, ...stringArray(update.relatedCharacters)])]
    }
    if (typeof update.status === 'string') {
      const status = update.status === 'closed' || update.status === '已回收' ? 'closed' : 'open'
      thread.status = status
      if (status === 'closed') {
        thread.resolvedChapter = chapter
        if (typeof update.resolution === 'string') thread.resolution = update.resolution.trim()
      } else {
        thread.resolvedChapter = null
        thread.resolution = ''
      }
    }
    thread.updatedAt = nowIso()
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} rawForeshadowing
 * @param {number} chapter
 */
function applyForeshadowing(state, rawForeshadowing, chapter) {
  if (!Array.isArray(rawForeshadowing)) return
  for (const raw of rawForeshadowing) {
    const update = plainObject(raw)
    const text = typeof update.text === 'string' ? update.text.trim() : ''
    const id = typeof update.id === 'string' ? update.id.trim() : ''
    if (text === '' && id === '') continue
    let item = state.foreshadowing.find(
      (entry) => (id && entry.id === id) || (text && normalizeName(entry.text) === normalizeName(text)),
    )
    if (!item) {
      item = {
        id: uniqueId(slugify(id || text, 'foreshadowing'), state.foreshadowing.map((entry) => entry.id)),
        text: text || id,
        status: 'planted',
        plantedChapter: chapter,
        payoffChapter: null,
        payoff: '',
        updatedAt: nowIso(),
      }
      state.foreshadowing.push(item)
    }
    if (text !== '') item.text = text
    if (typeof update.status === 'string') {
      if (update.status === 'paid-off' || update.status === '已回收') {
        item.status = 'paid-off'
        item.payoffChapter = chapter
      } else if (update.status === 'abandoned' || update.status === '已放弃') {
        item.status = 'abandoned'
      } else {
        item.status = 'planted'
        item.payoffChapter = null
        item.payoff = ''
      }
    }
    if (typeof update.payoff === 'string') item.payoff = update.payoff.trim()
    item.updatedAt = nowIso()
  }
}

/**
 * @param {Record<string, any>} state
 * @param {string} reference
 * @param {string} [explicitId]
 * @returns {Record<string, any>}
 */
function ensureCharacter(state, reference, chapter, explicitId) {
  const byId = explicitId
    ? Object.values(state.characters).find((character) => character.id === explicitId)
    : undefined
  const existing = byId ?? findCharacter(state, reference)
  if (existing) return existing
  const name = reference
  const id = uniqueId(slugify(explicitId || name, 'character'), Object.keys(state.characters))
  const character = {
    id,
    name,
    aliases: [],
    role: '配角',
    status: '未知',
    location: '',
    mood: '',
    profile: {
      personality: '',
      appearance: '',
      background: '',
      motivation: '',
      abilities: '',
      arc: '',
    },
    relationships: [],
    experiences: [],
    notes: '',
    firstChapter: chapter,
    lastChapter: chapter,
    updatedAt: nowIso(),
  }
  state.characters[id] = character
  return character
}

/**
 * @param {Record<string, any>} state
 * @param {string} name
 * @param {number} chapter
 * @returns {Record<string, any>}
 */
function createCharacterStub(state, name, chapter) {
  const existed = findCharacter(state, name)
  const character = ensureCharacter(state, name, chapter)
  if (!existed) {
    character.role = '（关系提及）'
    character.status = '未登场'
    character.stub = true
  } else if (character.experiences.length === 0 && character.status === '未知') {
    character.status = '未登场'
    character.stub = true
  }
  return character
}

/**
 * @param {Record<string, any>} state
 * @param {string} reference
 * @returns {Record<string, any> | undefined}
 */
export function findCharacter(state, reference) {
  const raw = String(reference ?? '').trim()
  if (raw === '') return undefined
  const normalized = normalizeName(raw)
  return Object.values(state.characters).find(
    (character) =>
      character.id === raw ||
      character.name === raw ||
      normalizeName(character.name) === normalized ||
      character.aliases.some((alias) => alias === raw || normalizeName(alias) === normalized),
  )
}

/**
 * @param {string} status
 * @returns {string}
 */
function normalizeArcStatus(status) {
  const value = String(status).trim()
  if (['closed', '已完结', '完结', '结束'].includes(value)) return '已完结'
  if (['planned', '未开始', '计划中'].includes(value)) return '未开始'
  return '进行中'
}


