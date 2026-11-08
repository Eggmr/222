/**
 * Build the read-side context pack for the next chapter.
 *
 * The pack is deliberately structured (canon first, recent prose last) so the
 * model cannot accidentally treat a stale chapter as canon when the database
 * says otherwise.
 *
 * @module dsh-novel-memory/lib/context
 */

import path from 'node:path'
import {
  clampInt,
  countWords,
  readTextIfExists,
  stringArray,
  truncateText,
} from './util.js'
import { loadMemory, memoryPaths } from './store.js'
import { findCharacter } from './commit.js'
import { resolveCharacterName } from './render.js'

/**
 * @param {{ memoryDir: string, chapter?: number, query?: string, characters?: string[], recentChapters?: number, includeLastChapter?: boolean, maxChars?: number, config?: Record<string, any> }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function buildContext(input) {
  const memory = await loadMemory(input.memoryDir)
  const { project, state, memoryDir } = memory
  const paths = memoryPaths(memoryDir)
  const warnings = []
  const lastChapter = Number(state.progress.lastChapter) || 0
  const targetChapter = input.chapter == null ? lastChapter + 1 : Math.max(1, Math.trunc(Number(input.chapter)) || 1)
  const maxChars = clampInt(
    input.maxChars ?? input.config?.maxContextChars,
    30000,
    4000,
    200000,
  )
  const recentChapters = clampInt(input.recentChapters, 3, 1, 20)
  const includeLastChapter = input.includeLastChapter !== false
  const query = typeof input.query === 'string' ? input.query.trim() : ''

  if (targetChapter <= lastChapter) {
    warnings.push(
      `请求的章节是第 ${targetChapter} 章，但记忆库已提交到第 ${lastChapter} 章。` +
        '如果这是要重写的旧章，请先用 novel_rollback 回滚；否则请把 chapter 设为 ' + (lastChapter + 1) + '。',
    )
  }

  const selected = selectCharacters(state, input.characters, query, warnings)
  const lastChapterMeta = state.chapters.find((item) => item.number === lastChapter) || null
  let lastChapterText = ''
  if (includeLastChapter && lastChapterMeta?.file) {
    const raw = await readTextIfExists(path.join(memoryDir, lastChapterMeta.file))
    if (raw == null) {
      warnings.push('上一章正文文件缺失：' + lastChapterMeta.file)
    } else {
      lastChapterText = raw
    }
  } else if (includeLastChapter && !lastChapterMeta && lastChapter > 0) {
    warnings.push('章节索引里找不到上一章记录。')
  }

  const requiredSections = []
  const optionalSections = []

  requiredSections.push({
    title: '任务与铁律',
    body: renderTask({ project, state, targetChapter, lastChapter, query }),
  })
  requiredSections.push({
    title: '项目与当前进度',
    body: renderProjectProgress(project, state),
  })
  requiredSections.push({
    title: '当前人物状态（必须遵守）',
    body: renderSelectedCharacters(selected, state),
  })
  requiredSections.push({
    title: '未回收线索与伏笔（本章必须考虑）',
    body: renderOpenThreads(state),
  })
  if (state.nextHooks.length) {
    requiredSections.push({
      title: '上一章留下的钩子',
      body: state.nextHooks.map((hook) => '- ' + hook).join('\n'),
    })
  }
  if (includeLastChapter) {
    requiredSections.push({
      title: '上一章正文（续写衔接用）',
      body: lastChapterText
        ? truncateText(lastChapterText, Math.min(9000, Math.floor(maxChars * 0.35)), { tail: true })
        : '（还没有已提交的章节，这是故事的开头。）',
    })
  }
  if (warnings.length) {
    requiredSections.push({
      title: '记忆库提醒',
      body: warnings.map((warning) => '- ' + warning).join('\n'),
    })
  }

  optionalSections.push({
    title: '最近章节摘要',
    body: renderRecentSummaries(state, recentChapters),
  })
  optionalSections.push({
    title: '最近时间线',
    body: renderRecentTimeline(state, recentChapters),
  })
  optionalSections.push({
    title: '世界总览与规则',
    body: renderWorld(state),
  })
  optionalSections.push({
    title: '地点 / 势力 / 物品',
    body: renderWorldEntries(state),
  })
  optionalSections.push({
    title: '其他人物索引',
    body: renderOtherCharacters(state, selected),
  })

  const assembled = assemble(requiredSections, optionalSections, maxChars)
  const includedCharacters = selected.map((character) => character.name)
  const text = [
    '<novel-memory readonly="true">',
    '【小说记忆库 · 只读上下文】',
    '以下内容是已经发生的事实与当前状态，不是写作建议。续写时不得让角色知道尚未发生的信息，不得违反已登记的能力、关系和时间线。',
    '',
    assembled.text.trim(),
    '',
    '【本轮结束条件】',
    '1) 正文写完；2) 调用 novel_commit 提交正文、summary 和 changes；3) 提交成功后才算完成一轮。只回复正文而不提交，会导致下一轮记忆缺失。',
    '</novel-memory>',
  ].join('\n')

  return {
    memoryDir,
    projectTitle: project.title,
    chapter: targetChapter,
    lastChapter,
    maxChars,
    includedCharacters,
    sections: assembled.included,
    omittedSections: assembled.omitted,
    warnings,
    chars: text.length,
    text,
  }
}

/**
 * @param {Record<string, any>} state
 * @param {unknown} requested
 * @param {string} query
 * @param {string[]} warnings
 * @returns {Array<Record<string, any>>}
 */
function selectCharacters(state, requested, query, warnings) {
  const all = Object.values(state.characters)
  const chosen = new Map()
  const names = stringArray(requested)
  for (const name of names) {
    const character = findCharacter(state, name)
    if (character) chosen.set(character.id, character)
    else warnings.push('上下文请求的人物不存在：' + name)
  }
  if (query) {
    for (const character of all) {
      if (
        character.name.includes(query) ||
        character.aliases.some((alias) => alias.includes(query)) ||
        character.profile.personality.includes(query)
      ) {
        chosen.set(character.id, character)
      }
    }
  }
  if (chosen.size === 0) {
    const active = all
      .filter((character) => character.status !== '死亡' && character.status !== '已退场')
      .sort(compareForContext)
    for (const character of active.slice(0, 8)) chosen.set(character.id, character)
    const protagonists = all.filter((character) => character.role === '主角')
    for (const character of protagonists) chosen.set(character.id, character)
  }
  return [...chosen.values()].sort(compareForContext).slice(0, 12)
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {number}
 */
function compareForContext(a, b) {
  const rank = (character) => {
    if (character.role === '主角') return 0
    if (character.role === '反派') return 1
    if (character.role === '重要配角') return 2
    return 3
  }
  return rank(a) - rank(b) || b.lastChapter - a.lastChapter || a.name.localeCompare(b.name, 'zh-CN')
}

/**
 * @param {{ project: any, state: any, targetChapter: number, lastChapter: number, query: string }} input
 * @returns {string}
 */
function renderTask(input) {
  const { project, state, targetChapter, lastChapter, query } = input
  const lines = [
    `本次要写：第 ${targetChapter} 章${targetChapter === lastChapter + 1 ? '（紧接上一章）' : ''}。`,
    `作品：《${project.title}》${project.genre ? ' ｜ 类型：' + project.genre : ''}${project.style ? ' ｜ 文风：' + project.style : ''}`,
    query ? `本次写作焦点：${query}` : '',
    '',
    '硬性要求：',
    '- 人物性格、关系、能力上限、所在地点必须与数据库一致；要改变就必须在本章正文中写出过程，并在 changes 里登记。',
    '- 至少推进或回收一条未回收线索；若本章刻意不推进，需在正文或 summary 中交代原因。',
    '- 不要重复上一章已经完成的动作；不要让人物知道其不在场时发生的事。',
    '- 正文写完后必须调用 novel_commit。changes 只记录正文中真实发生的事，不记录计划。',
  ]
  if (state.nextHooks.length) {
    lines.push('- 尽量回应上一章留下的钩子，但不要机械回收；可以转化为新的冲突。')
  }
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * @param {Record<string, any>} project
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderProjectProgress(project, state) {
  const activeArcs = Object.values(state.arcs)
    .filter((arc) => arc.status === '进行中')
    .map((arc) => `${arc.name}（第 ${arc.startChapter} 章起）：${arc.summary || '无概要'}`)
  return [
    `标题：${project.title}`,
    project.synopsis ? `简介：${project.synopsis}` : '',
    `已提交：第 ${state.progress.lastChapter} 章${state.progress.lastChapterTitle ? '《' + state.progress.lastChapterTitle + '》' : ''}`,
    `总字数：${state.progress.totalWords || 0}`,
    `故事内时间：${state.progress.timelinePosition || '（未填写）'}`,
    activeArcs.length ? `当前世界线：\n- ${activeArcs.join('\n- ')}` : '当前世界线：（无进行中的篇章）',
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * @param {Array<Record<string, any>>} characters
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderSelectedCharacters(characters, state) {
  if (characters.length === 0) return '（数据库里还没有人物。第一章需要先建立至少一个视角人物。）'
  return characters
    .map((character) => {
      const profile = character.profile || {}
      const relations = character.relationships.length
        ? character.relationships
            .map((rel) => {
              const target = resolveCharacterName(state, rel.target)
              return `${target}（${rel.type || '关系未定'}${rel.note ? '：' + rel.note : ''}）`
            })
            .join('；')
        : '无登记'
      const experiences = character.experiences.length
        ? character.experiences
            .slice()
            .sort((a, b) => a.chapter - b.chapter)
            .slice(-5)
            .map((item) => `第${item.chapter}章：${item.text}`)
            .join('；')
        : '无登记'
      return [
        `### ${character.name}（${character.role || '配角'}｜${character.status || '未知'}｜${character.location || '位置未知'}）`,
        character.aliases.length ? `别名：${character.aliases.join('、')}` : '',
        profile.personality ? `性格：${truncateText(profile.personality, 700)}` : '',
        profile.motivation ? `动机：${truncateText(profile.motivation, 500)}` : '',
        profile.abilities ? `能力：${truncateText(profile.abilities, 700)}` : '',
        profile.background ? `背景：${truncateText(profile.background, 500)}` : '',
        profile.arc ? `人物弧光：${truncateText(profile.arc, 500)}` : '',
        character.mood ? `当前情绪：${character.mood}` : '',
        `关系：${relations}`,
        `最近经历：${experiences}`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderOpenThreads(state) {
  const threads = state.threads.filter((item) => item.status === 'open')
  const foreshadowing = state.foreshadowing.filter((item) => item.status === 'planted')
  const lines = []
  if (threads.length) {
    lines.push('未回收线索：')
    for (const thread of threads.slice(0, 20)) {
      lines.push(
        `- [${thread.id}] ${thread.title}（第${thread.plantedChapter}章埋下）${thread.description ? '：' + thread.description : ''}` +
          (thread.relatedCharacters.length ? ' ｜ 相关：' + thread.relatedCharacters.join('、') : ''),
      )
    }
  }
  if (foreshadowing.length) {
    lines.push('未回收伏笔：')
    for (const item of foreshadowing.slice(0, 20)) {
      lines.push(`- [${item.id}] ${item.text}（第${item.plantedChapter}章埋下）`)
    }
  }
  return lines.length ? lines.join('\n') : '（当前没有登记未回收线索。第一章可以主动埋下 1–2 条。）'
}

/**
 * @param {Record<string, any>} state
 * @param {number} count
 * @returns {string}
 */
function renderRecentSummaries(state, count) {
  const chapters = state.chapters.slice(-count)
  if (!chapters.length) return '（暂无章节）'
  return chapters
    .map((chapter) => `- 第${chapter.number}章《${chapter.title}》${chapter.wordCount}字：${chapter.summary}`)
    .join('\n')
}

/**
 * @param {Record<string, any>} state
 * @param {number} count
 * @returns {string}
 */
function renderRecentTimeline(state, count) {
  const minChapter = Math.max(1, (state.progress.lastChapter || 1) - count + 1)
  const events = state.timeline.filter((event) => event.chapter >= minChapter)
  if (!events.length) return '（暂无时间线事件）'
  return events
    .slice(-40)
    .map((event) => {
      const meta = [event.time, event.location].filter(Boolean).join(' ｜ ')
      return `- 第${event.chapter}章${meta ? '（' + meta + '）' : ''}：${event.event}${event.consequences ? ' → ' + event.consequences : ''}`
    })
    .join('\n')
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderWorld(state) {
  const world = state.world
  const lines = []
  if (world.overview) lines.push(world.overview)
  if (world.rules.length) {
    lines.push('规则：')
    for (const rule of world.rules.slice(0, 30)) {
      lines.push(`- ${rule.title || rule.name || '规则'}：${truncateText(rule.text || rule.description || '', 500)}`)
    }
  }
  return lines.length ? lines.join('\n') : '（尚无世界规则；第一章需要建立基本规则，但不能与后续冲突。）'
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderWorldEntries(state) {
  const lines = []
  for (const [label, items] of [
    ['地点', state.world.locations],
    ['势力', state.world.factions],
    ['物品', state.world.items],
  ]) {
    if (!items.length) continue
    lines.push(label + '：')
    for (const item of items.slice(0, 30)) {
      lines.push(`- ${item.name || item.title || '未命名'}：${truncateText(item.description || '', 300)}`)
    }
  }
  return lines.length ? lines.join('\n') : '（暂无地点/势力/物品登记）'
}

/**
 * @param {Record<string, any>} state
 * @param {Array<Record<string, any>>} selected
 * @returns {string}
 */
function renderOtherCharacters(state, selected) {
  const selectedIds = new Set(selected.map((character) => character.id))
  const others = Object.values(state.characters)
    .filter((character) => !selectedIds.has(character.id))
    .sort(compareForContext)
    .slice(0, 40)
  if (!others.length) return '（没有其他人物）'
  return others
    .map(
      (character) =>
        `- ${character.name}（${character.role || '配角'}｜${character.status || '未知'}｜${character.location || '位置未知'}｜最近第${character.lastChapter}章）`,
    )
    .join('\n')
}

/**
 * @param {Array<{ title: string, body: string }>} required
 * @param {Array<{ title: string, body: string }>} optional
 * @param {number} maxChars
 * @returns {{ text: string, included: string[], omitted: string[] }}
 */
function assemble(required, optional, maxChars) {
  const included = []
  const entries = []
  const lengthOf = (entry) => entry.title.length + entry.body.length + 8

  const add = (section) => {
    entries.push({ title: section.title, body: String(section.body ?? '').trim() })
    if (!included.includes(section.title)) included.push(section.title)
  }
  const totalLength = () => entries.reduce((sum, entry) => sum + lengthOf(entry), 0)

  for (const section of required) {
    let body = String(section.body ?? '')
    const overhead = section.title.length + 8
    const remaining = maxChars - totalLength() - overhead
    if (remaining < 200) {
      body = truncateText(body, Math.max(120, remaining), { tail: section.title.includes('上一章') })
    }
    add({ ...section, body })
  }

  // If required canon still overflows, trim the largest body instead of
  // dropping a whole section. The task and warnings are short, so the
  // character/last-chapter blocks absorb most of the trimming.
  let guard = 0
  while (totalLength() > maxChars && entries.length > 1 && guard < 100) {
    guard += 1
    let largestIndex = 0
    for (let i = 1; i < entries.length; i += 1) {
      if (entries[i].body.length > entries[largestIndex].body.length) largestIndex = i
    }
    const entry = entries[largestIndex]
    const overflow = totalLength() - maxChars
    const keep = Math.max(200, entry.body.length - Math.max(200, Math.ceil(overflow / 2)))
    if (keep >= entry.body.length) break
    entry.body = truncateText(entry.body, keep, { tail: entry.title.includes('上一章') })
  }

  const omitted = []
  for (const section of optional) {
    const candidate = { title: section.title, body: String(section.body ?? '').trim() }
    if (totalLength() + lengthOf(candidate) <= maxChars) add(candidate)
    else omitted.push(section.title)
  }

  const parts = entries.map((entry) => '## ' + entry.title + '\n\n' + entry.body + '\n')
  if (omitted.length) {
    parts.push('## 已省略\n\n因上下文预算限制，以下部分未展开：' + omitted.join('、') + '。可用 novel_search 按关键词查询。\n')
  }
  return { text: parts.join('\n'), included, omitted }
}

/**
 * @param {string} memoryDir
 * @returns {Promise<string>}
 */
export async function contextFingerprint(memoryDir) {
  const memory = await loadMemory(memoryDir)
  return `${memory.project.updatedAt}|${memory.state.progress.lastChapter}|${memory.state.chapters.length}|${countWords(JSON.stringify(memory.state))}`
}
