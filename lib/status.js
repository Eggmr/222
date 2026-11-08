/**
 * Memory health inspection and repair (Markdown views are rebuildable; prose
 * and JSON state are not silently rewritten).
 *
 * @module dsh-novel-memory/lib/status
 */

import path from 'node:path'
import {
  exists,
  readTextIfExists,
  sha256,
} from './util.js'
import {
  applyPlanUnlocked,
  listCommitDirs,
  loadMemoryUnlocked,
  makeLedgerEntry,
  memoryPaths,
  readLedger,
  withLock,
} from './store.js'
import { characterFileId, arcFileId, renderMarkdownFiles } from './render.js'

/**
 * @param {{ memoryDir: string, repair?: boolean }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function getStatus(input) {
  const root = path.resolve(input.memoryDir)
  return withLock(root, async () => {
    const memory = await loadMemoryUnlocked(root)
    const paths = memoryPaths(root)
    const issues = await inspect(root, memory, paths)
    let repairedFiles = []
    if (input.repair === true) {
      const repairFiles = [
        { path: 'project.json', content: JSON.stringify(memory.project, null, 2) + '\n' },
        { path: 'state/current.json', content: JSON.stringify(memory.state, null, 2) + '\n' },
        ...renderMarkdownFiles(memory.state, memory.project),
      ]
      const result = await applyPlanUnlocked(root, { files: repairFiles, deletes: [] })
      repairedFiles = result.files
    }
    const text = renderStatus(memory, issues, repairedFiles)
    return {
      memoryDir: root,
      title: memory.project.title,
      chapter: memory.state.progress.lastChapter,
      chapters: memory.state.chapters.length,
      characters: Object.keys(memory.state.characters).length,
      openThreads: memory.state.threads.filter((item) => item.status === 'open').length,
      openForeshadowing: memory.state.foreshadowing.filter((item) => item.status === 'planted').length,
      words: memory.state.progress.totalWords,
      healthy: issues.filter((item) => item.level === 'error').length === 0,
      issues,
      repairedFiles,
      text,
    }
  })
}

/**
 * @param {string} root
 * @param {any} memory
 * @param {Record<string, string>} paths
 * @returns {Promise<Array<{ level: string, code: string, message: string }>>}
 */
async function inspect(root, memory, paths) {
  const issues = []
  const { state, project } = memory

  if (state.progress.lastChapter !== (state.chapters.at(-1)?.number ?? 0)) {
    issues.push({
      level: 'error',
      code: 'PROGRESS_MISMATCH',
      message: `progress.lastChapter=${state.progress.lastChapter}，但章节索引最后是第 ${state.chapters.at(-1)?.number ?? 0} 章。`,
    })
  }
  for (let i = 0; i < state.chapters.length; i += 1) {
    const chapter = state.chapters[i]
    if (i > 0 && chapter.number !== state.chapters[i - 1].number + 1) {
      issues.push({
        level: 'warning',
        code: 'CHAPTER_GAP',
        message: `章节号不连续：第 ${state.chapters[i - 1].number} 章后是第 ${chapter.number} 章。`,
      })
    }
    if (!chapter.file) {
      issues.push({ level: 'error', code: 'CHAPTER_FILE_MISSING', message: `第 ${chapter.number} 章没有记录文件路径。` })
      continue
    }
    const file = path.join(root, chapter.file)
    const text = await readTextIfExists(file)
    if (text == null) {
      issues.push({ level: 'error', code: 'CHAPTER_FILE_MISSING', message: `第 ${chapter.number} 章正文文件缺失：${chapter.file}` })
      continue
    }
    const body = extractProse(text)
    if (body != null && chapter.hash && sha256(body) !== chapter.hash) {
      issues.push({
        level: 'warning',
        code: 'CHAPTER_HASH_MISMATCH',
        message: `第 ${chapter.number} 章正文与索引哈希不一致（可能被手动改过）：${chapter.file}`,
      })
    }
  }

  for (const character of Object.values(state.characters)) {
    const file = path.join(paths.characters, characterFileId(character) + '.md')
    if (!(await exists(file))) {
      issues.push({
        level: 'warning',
        code: 'CHARACTER_VIEW_MISSING',
        message: `人物视图缺失：${path.relative(root, file)}（可用 repair 重建）`,
      })
    }
  }
  for (const arc of Object.values(state.arcs)) {
    const file = path.join(paths.arcs, arcFileId(arc) + '.md')
    if (!(await exists(file))) {
      issues.push({
        level: 'warning',
        code: 'ARC_VIEW_MISSING',
        message: `世界线视图缺失：${path.relative(root, file)}（可用 repair 重建）`,
      })
    }
  }
  for (const relative of [
    'README.md',
    'characters/_index.md',
    'world/overview.md',
    'world/rules.md',
    'world/locations.md',
    'world/factions.md',
    'world/items.md',
    'plot/timeline.md',
    'plot/threads.md',
    'plot/chapter-index.md',
    'plot/arcs/_index.md',
  ]) {
    if (!(await exists(path.join(root, relative)))) {
      issues.push({
        level: 'warning',
        code: 'VIEW_MISSING',
        message: `自动视图缺失：${relative}（可用 repair 重建）`,
      })
    }
  }

  const ledger = await readLedger(root)
  if (ledger.some((item) => item.__corrupt)) {
    const corrupt = ledger.find((item) => item.__corrupt)
    issues.push({
      level: 'error',
      code: 'LEDGER_CORRUPT',
      message: `.novel-memory/ledger.jsonl 第 ${corrupt.line} 行无法解析。`,
    })
  } else {
    let prev = 'GENESIS'
    for (const entry of ledger) {
      if (entry.prevHash !== prev) {
        issues.push({
          level: 'error',
          code: 'LEDGER_CHAIN_BROKEN',
          message: `审计日志第 ${entry.seq} 条的 prevHash 与上一条不匹配。`,
        })
      }
      const { hash, ...rest } = entry
      const expected = makeLedgerEntry(rest).hash
      if (expected !== hash) {
        issues.push({
          level: 'error',
          code: 'LEDGER_HASH_MISMATCH',
          message: `审计日志第 ${entry.seq} 条的哈希校验失败。`,
        })
      }
      prev = entry.hash
    }
    const last = ledger.at(-1)
    if (last && last.type === 'commit' && last.chapter !== state.progress.lastChapter) {
      issues.push({
        level: 'warning',
        code: 'LEDGER_PROGRESS_MISMATCH',
        message: `审计日志最后提交第 ${last.chapter} 章，但状态记录第 ${state.progress.lastChapter} 章。`,
      })
    }
  }

  const commits = await listCommitDirs(root)
  if (state.progress.lastChapter > 0 && commits.length === 0) {
    issues.push({
      level: 'warning',
      code: 'NO_COMMIT_HISTORY',
      message: '已提交章节但找不到 history/commits 快照，无法回滚。',
    })
  }

  if (!project.synopsis) {
    issues.push({ level: 'info', code: 'NO_SYNOPSIS', message: 'project.json 还没有作品简介。' })
  }
  if (Object.keys(state.characters).length === 0) {
    issues.push({ level: 'info', code: 'NO_CHARACTERS', message: '还没有登记人物。第一章提交时应建立视角人物。' })
  }
  if (state.threads.filter((item) => item.status === 'open').length === 0) {
    issues.push({ level: 'info', code: 'NO_OPEN_THREADS', message: '没有未回收线索，下一章可能缺少叙事动力。' })
  }

  return issues
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function extractProse(text) {
  const marker = '\n---\n'
  const index = text.indexOf(marker)
  if (index < 0) return null
  return text.slice(index + marker.length).trim()
}

/**
 * @param {any} memory
 * @param {Array<{ level: string, code: string, message: string }>} issues
 * @param {string[]} repairedFiles
 * @returns {string}
 */
function renderStatus(memory, issues, repairedFiles) {
  const { project, state } = memory
  const errors = issues.filter((item) => item.level === 'error')
  const warnings = issues.filter((item) => item.level === 'warning')
  const infos = issues.filter((item) => item.level === 'info')
  const activeArcs = Object.values(state.arcs)
    .filter((arc) => arc.status === '进行中')
    .map((arc) => arc.name)
    .join('、') || '（无）'
  const lines = [
    `# 《${project.title}》记忆库状态`,
    '',
    `- 路径：\`${memory.memoryDir}\``,
    `- 进度：第 ${state.progress.lastChapter} 章${state.progress.lastChapterTitle ? '《' + state.progress.lastChapterTitle + '》' : ''}`,
    `- 总字数：${state.progress.totalWords || 0}`,
    `- 故事内时间：${state.progress.timelinePosition || '（未填写）'}`,
    `- 当前世界线：${activeArcs}`,
    `- 人物：${Object.keys(state.characters).length} 位 ｜ 篇章：${Object.keys(state.arcs).length} 个`,
    `- 未回收线索：${state.threads.filter((item) => item.status === 'open').length} 条 ｜ 未回收伏笔：${state.foreshadowing.filter((item) => item.status === 'planted').length} 条`,
    `- 最近提交：${state.progress.lastCommitAt || '（尚未提交）'}`,
    '',
    `## 健康检查：${errors.length === 0 ? '通过' : '发现 ' + errors.length + ' 个错误'}${warnings.length ? '，' + warnings.length + ' 个警告' : ''}`,
  ]
  if (issues.length === 0) {
    lines.push('', '未发现问题。')
  } else {
    for (const issue of [...errors, ...warnings, ...infos]) {
      const icon = issue.level === 'error' ? '✗' : issue.level === 'warning' ? '!' : '·'
      lines.push(`- ${icon} [${issue.code}] ${issue.message}`)
    }
  }
  if (repairedFiles.length) {
    lines.push('', `已重建 ${repairedFiles.length} 个自动视图文件。`)
  }
  lines.push('', `下一步：novel_context 读取第 ${state.progress.lastChapter + 1} 章的写作上下文。`)
  return lines.join('\n')
}
