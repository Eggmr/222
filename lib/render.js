/**
 * Render the human-readable (and model-readable) Markdown views from the
 * canonical JSON state. Every view is regenerated after each commit, so the
 * folder always stays internally consistent.
 *
 * @module dsh-novel-memory/lib/render
 */

import { escapeMarkdownCell, pad4, slugify, stableStringify } from './util.js'

/**
 * @param {number} number
 * @param {string} title
 * @returns {string}
 */
export function chapterFileRelative(number, title) {
  return 'chapters/' + pad4(number) + '-' + slugify(title || 'chapter', 'chapter') + '.md'
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} project
 * @returns {Array<{ path: string, content: string }>}
 */
export function renderMarkdownFiles(state, project) {
  const files = []
  files.push({ path: 'README.md', content: renderReadme(state, project) })

  const characters = Object.values(state.characters).sort(compareCharacters)
  files.push({ path: 'characters/_index.md', content: renderCharacterIndex(characters, state) })
  for (const character of characters) {
    files.push({
      path: 'characters/' + characterFileId(character) + '.md',
      content: renderCharacter(character, state),
    })
  }

  files.push({ path: 'world/overview.md', content: renderWorldOverview(state, project) })
  files.push({ path: 'world/rules.md', content: renderWorldList('世界规则', state.world.rules, 'rule') })
  files.push({ path: 'world/locations.md', content: renderWorldList('地点', state.world.locations, 'location') })
  files.push({ path: 'world/factions.md', content: renderWorldList('势力与组织', state.world.factions, 'faction') })
  files.push({ path: 'world/items.md', content: renderWorldList('重要物品', state.world.items, 'item') })

  files.push({ path: 'plot/timeline.md', content: renderTimeline(state) })
  files.push({ path: 'plot/threads.md', content: renderThreads(state) })
  files.push({ path: 'plot/chapter-index.md', content: renderChapterIndex(state) })
  files.push({ path: 'plot/arcs/_index.md', content: renderArcIndex(state) })
  for (const arc of Object.values(state.arcs).sort((a, b) => a.startChapter - b.startChapter)) {
    files.push({
      path: 'plot/arcs/' + arcFileId(arc) + '.md',
      content: renderArc(arc, state),
    })
  }
  return files
}

/**
 * @param {Record<string, any>} character
 * @returns {string}
 */
export function characterFileId(character) {
  return slugify(character.id || character.name || 'character', 'character')
}

/**
 * @param {Record<string, any>} arc
 * @returns {string}
 */
export function arcFileId(arc) {
  return slugify(arc.id || arc.name || 'arc', 'arc')
}

/**
 * @param {Record<string, any>} project
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function renderReadme(state, project) {
  const characters = Object.values(state.characters)
  const arcs = Object.values(state.arcs)
  const openThreads = state.threads.filter((item) => item.status === 'open')
  const openForeshadowing = state.foreshadowing.filter((item) => item.status === 'planted')
  const last = state.progress.lastChapter || 0
  const activeArc = arcs.filter((arc) => arc.status === '进行中').map((arc) => arc.name).join('、') || '（无）'
  return `# ${project.title} · 小说记忆库

> 本文件夹由 **dsh-novel-memory** 自动维护。AI 写正文前读取这里，写完后通过
> \`novel_commit\` 回写；所有 Markdown 视图都会自动重建。

## 项目

- 类型：${project.genre || '（未填写）'}
- 语言：${project.language || 'zh-CN'}
- 文风：${project.style || '（未填写）'}
- 简介：${project.synopsis || '（未填写）'}

## 当前进度

- 已提交：第 ${last} 章${state.progress.lastChapterTitle ? '《' + state.progress.lastChapterTitle + '》' : ''}
- 总字数：${state.progress.totalWords || 0}
- 故事内时间：${state.progress.timelinePosition || '（未填写）'}
- 当前世界线：${activeArc}
- 人物：${characters.length} 位（${characters.filter((item) => item.status !== '已退场' && item.status !== '死亡').length} 位活跃）
- 未回收线索：${openThreads.length} 条
- 未回收伏笔：${openForeshadowing.length} 条

## 文件地图

| 路径 | 内容 |
|---|---|
| \`state/current.json\` | **唯一事实源**：人物、关系、世界观、世界线、时间线、线索、章节索引 |
| \`characters/<角色ID>.md\` | 每个角色一份：性格、外貌、背景、动机、能力、关系、经历 |
| \`characters/_index.md\` | 人物总表 |
| \`world/overview.md\` | 世界总览 |
| \`world/rules.md\` | 力量体系 / 世界规则 |
| \`world/locations.md\` | 地点 |
| \`world/factions.md\` | 势力与组织 |
| \`world/items.md\` | 重要物品 |
| \`plot/timeline.md\` | 按章节记录的世界线事件 |
| \`plot/threads.md\` | 未回收线索、已回收线索、伏笔 |
| \`plot/chapter-index.md\` | 章节索引与摘要 |
| \`plot/arcs/<篇章ID>.md\` | 每个篇章 / 世界线一份 |
| \`chapters/0001-....md\` | 正文原稿 |
| \`.novel-memory/ledger.jsonl\` | 哈希链审计日志 |
| \`history/commits/\` | 每次提交前的状态快照，可回滚 |

## 每轮写作流程

1. \`novel_context\`：读取当前世界线、人物状态、关系、开放线索和上一章。
2. 按上下文写正文；不得违反已登记事实。
3. \`novel_commit\`：提交正文 + 本章摘要 + 人物/世界观/世界线变化。
4. 插件自动更新 \`state/current.json\` 并重建全部 Markdown 视图。

> 不要手工编辑 Markdown 视图：它们会在下一次提交时被重建。需要修正记忆时，
> 通过 \`novel_commit\` 的 \`changes\` 或直接编辑 \`state/current.json\`（不推荐）。
`
}

/**
 * @param {Array<Record<string, any>>} characters
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderCharacterIndex(characters, state) {
  const rows = characters.map((character) => {
    const links = character.relationships
      .slice(0, 4)
      .map((rel) => resolveCharacterName(state, rel.target))
      .join('、')
    return [
      '[' + escapeMarkdownCell(character.name) + '](' + characterFileId(character) + '.md)',
      escapeMarkdownCell(character.role || ''),
      escapeMarkdownCell(character.status || ''),
      escapeMarkdownCell(character.location || ''),
      character.firstChapter + '–' + character.lastChapter,
      escapeMarkdownCell(links),
    ].join(' | ')
  })
  return `# 人物总表

| 人物 | 身份 | 状态 | 当前位置 | 出场章节 | 主要关系 |
|---|---|---|---|---|---|
${rows.length ? rows.map((row) => '| ' + row + ' |').join('\n') : '| （暂无人物） |  |  |  |  |  |'}
`
}

/**
 * @param {Record<string, any>} character
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderCharacter(character, state) {
  const profile = character.profile || {}
  const relations = character.relationships.length
    ? character.relationships
        .map((rel) => {
          const targetName = resolveCharacterName(state, rel.target)
          const since = rel.sinceChapter ? '第 ' + rel.sinceChapter + ' 章' : ''
          return `| ${escapeMarkdownCell(targetName)} | ${escapeMarkdownCell(rel.type || '')} | ${escapeMarkdownCell(rel.note || '')} | ${since} |`
        })
        .join('\n')
    : '| （暂无） |  |  |  |'
  const experiences = character.experiences.length
    ? [...character.experiences]
        .sort((a, b) => a.chapter - b.chapter)
        .map((item) => `- **第 ${item.chapter} 章**：${item.text}`)
        .join('\n')
    : '- （暂无）'
  return `# ${character.name}

> 角色 ID：\`${character.id}\` ｜ 身份：${character.role || '配角'} ｜ 状态：${character.status || '未知'} ｜ 当前位置：${character.location || '未知'}
> 首次出场：第 ${character.firstChapter} 章 ｜ 最近出场：第 ${character.lastChapter} 章
> 最后更新：${character.updatedAt || ''}

## 性格

${profile.personality || '（待补充）'}

## 外貌

${profile.appearance || '（待补充）'}

## 背景

${profile.background || '（待补充）'}

## 动机与目标

${profile.motivation || '（待补充）'}

## 能力

${profile.abilities || '（待补充）'}

## 人物弧光

${profile.arc || '（待补充）'}

## 关系

| 对象 | 关系 | 说明 | 起始 |
|---|---|---|---|
${relations}

## 重要经历

${experiences}

## 备注

${character.notes || '（暂无）'}
`
}

/**
 * @param {Record<string, any>} state
 * @param {Record<string, any>} project
 * @returns {string}
 */
function renderWorldOverview(state, project) {
  const world = state.world
  return `# 世界总览

## 项目简介

${project.synopsis || '（待补充）'}

## 世界概述

${world.overview || '（待补充）'}

## 当前故事内时间

${state.progress.timelinePosition || '（未填写）'}

## 设定索引

- 世界规则：${world.rules.length} 条 → [rules.md](rules.md)
- 地点：${world.locations.length} 个 → [locations.md](locations.md)
- 势力与组织：${world.factions.length} 个 → [factions.md](factions.md)
- 重要物品：${world.items.length} 个 → [items.md](items.md)
`
}

/**
 * @param {string} title
 * @param {Array<Record<string, any>>} items
 * @param {string} kind
 * @returns {string}
 */
function renderWorldList(title, items, kind) {
  const blocks = items.length
    ? items
        .map((item, index) => {
          const name = item.name || item.title || kind + '-' + (index + 1)
          const meta = []
          if (item.chapter) meta.push('首次出现：第 ' + item.chapter + ' 章')
          if (item.updatedChapter) meta.push('最近更新：第 ' + item.updatedChapter + ' 章')
          return `### ${name}\n\n${item.description || item.text || '（待补充）'}${meta.length ? '\n\n> ' + meta.join(' ｜ ') : ''}`
        })
        .join('\n\n')
    : '（暂无）'
  return `# ${title}\n\n${blocks}\n`
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderTimeline(state) {
  const byChapter = new Map()
  for (const event of state.timeline) {
    if (!byChapter.has(event.chapter)) byChapter.set(event.chapter, [])
    byChapter.get(event.chapter).push(event)
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b)
  const body = chapters.length
    ? chapters
        .map((chapter) => {
          const events = byChapter.get(chapter)
          const lines = events
            .map((event) => {
              const meta = []
              if (event.time) meta.push(event.time)
              if (event.location) meta.push(event.location)
              if (event.characters.length) meta.push('人物：' + event.characters.join('、'))
              return `- ${meta.length ? '**' + meta.join(' ｜ ') + '**：' : ''}${event.event}${event.consequences ? '（后果：' + event.consequences + '）' : ''}`
            })
            .join('\n')
          return `## 第 ${chapter} 章\n\n${lines}`
        })
        .join('\n\n')
    : '（暂无事件）'
  return `# 世界线 · 时间线\n\n${body}\n`
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderThreads(state) {
  const open = state.threads.filter((item) => item.status === 'open')
  const closed = state.threads.filter((item) => item.status !== 'open')
  const planted = state.foreshadowing.filter((item) => item.status === 'planted')
  const paid = state.foreshadowing.filter((item) => item.status !== 'planted')
  const threadLine = (item) =>
    `- **${item.title}**（\`${item.id}\`，第 ${item.plantedChapter} 章埋下）${item.description ? '：' + item.description : ''}${item.relatedCharacters?.length ? '\n  - 相关人物：' + item.relatedCharacters.join('、') : ''}`
  const closedLine = (item) =>
    `- **${item.title}**（\`${item.id}\`，第 ${item.plantedChapter} 章埋下，第 ${item.resolvedChapter ?? '?'} 章回收）${item.resolution ? '：' + item.resolution : ''}`
  const fsLine = (item) =>
    `- **${item.text}**（\`${item.id}\`，第 ${item.plantedChapter} 章埋下）${item.payoffChapter ? ' → 第 ' + item.payoffChapter + ' 章回收：' + (item.payoff || '') : ''}`
  return `# 线索与伏笔

## 未回收线索（写作时必须考虑）

${open.length ? open.map(threadLine).join('\n') : '- （暂无）'}

## 已回收线索

${closed.length ? closed.map(closedLine).join('\n') : '- （暂无）'}

## 未回收伏笔

${planted.length ? planted.map(fsLine).join('\n') : '- （暂无）'}

## 已回收 / 已放弃伏笔

${paid.length ? paid.map(fsLine).join('\n') : '- （暂无）'}
`
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderChapterIndex(state) {
  const rows = state.chapters
    .slice()
    .sort((a, b) => a.number - b.number)
    .map((chapter) => {
      const link = chapter.file ? `[${escapeMarkdownCell(chapter.title)}](../${chapter.file})` : escapeMarkdownCell(chapter.title)
      return `| ${chapter.number} | ${link} | ${chapter.wordCount} | ${escapeMarkdownCell(chapter.summary)} | ${chapter.committedAt || ''} |`
    })
  return `# 章节索引

| 章 | 标题 | 字数 | 摘要 | 提交时间 |
|---|---|---|---|---|
${rows.length ? rows.join('\n') : '| - | （暂无章节） | 0 |  |  |'}
`
}

/**
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderArcIndex(state) {
  const rows = Object.values(state.arcs)
    .slice()
    .sort((a, b) => a.startChapter - b.startChapter)
    .map((arc) => {
      return `| [${escapeMarkdownCell(arc.name)}](${arcFileId(arc)}.md) | ${escapeMarkdownCell(arc.status)} | ${arc.startChapter}–${arc.endChapter ?? '?'} | ${escapeMarkdownCell(arc.summary)} |`
    })
  return `# 世界线 / 篇章总表

| 篇章 | 状态 | 起止章 | 概要 |
|---|---|---|---|
${rows.length ? rows.join('\n') : '| （暂无） |  |  |  |'}
`
}

/**
 * @param {Record<string, any>} arc
 * @param {Record<string, any>} state
 * @returns {string}
 */
function renderArc(arc, state) {
  const events = state.timeline.filter((event) => arc.chapters.includes(event.chapter))
  const chapterLines = arc.chapters.length
    ? arc.chapters.map((number) => {
        const chapter = state.chapters.find((item) => item.number === number)
        return `- 第 ${number} 章${chapter ? '《' + chapter.title + '》' : ''}${chapter?.summary ? '：' + chapter.summary : ''}`
      }).join('\n')
    : '- （暂无章节）'
  const eventLines = events.length
    ? events.map((event) => `- 第 ${event.chapter} 章${event.time ? '（' + event.time + '）' : ''}：${event.event}`).join('\n')
    : '- （暂无事件）'
  return `# ${arc.name}

- 状态：${arc.status}
- 起止：第 ${arc.startChapter} 章 – ${arc.endChapter == null ? '未完结' : '第 ' + arc.endChapter + ' 章'}
- 概要：${arc.summary || '（待补充）'}

## 章节

${chapterLines}

## 关键事件

${eventLines}
`
}

/**
 * @param {Record<string, any>} state
 * @param {string} target
 * @returns {string}
 */
export function resolveCharacterName(state, target) {
  const raw = String(target ?? '')
  const direct = Object.values(state.characters).find(
    (character) => character.id === raw || character.name === raw || character.aliases.includes(raw),
  )
  return direct ? direct.name : raw
}

/**
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {number}
 */
function compareCharacters(a, b) {
  const rank = (character) => {
    if (character.role === '主角') return 0
    if (character.role === '反派') return 1
    if (character.role === '重要配角') return 2
    return 3
  }
  return rank(a) - rank(b) || b.lastChapter - a.lastChapter || a.name.localeCompare(b.name, 'zh-CN')
}

/**
 * Render a chapter file. The prose body is preserved verbatim; the header is
 * generated metadata so the file stays self-describing.
 *
 * @param {{ number: number, title: string, summary: string, content: string, wordCount: number, committedAt: string, hash: string }} chapter
 * @returns {string}
 */
export function renderChapterFile(chapter) {
  return `# 第 ${chapter.number} 章 ${chapter.title}

> 摘要：${chapter.summary}
> 字数：${chapter.wordCount} ｜ 提交时间：${chapter.committedAt}
> 内容哈希：\`${chapter.hash}\`

---

${chapter.content.trim()}
`
}

/**
 * Compact state projection used in the context pack; avoids dumping raw JSON.
 *
 * @param {Record<string, any>} state
 * @returns {string}
 */
export function renderStateDigest(state) {
  return stableStringify({
    progress: state.progress,
    characters: Object.keys(state.characters).length,
    arcs: Object.keys(state.arcs).length,
    threads: state.threads.length,
    foreshadowing: state.foreshadowing.length,
    timeline: state.timeline.length,
  })
}
