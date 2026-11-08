/**
 * Create and bind a novel memory folder.
 *
 * @module dsh-novel-memory/lib/init
 */

import path from 'node:path'
import {
  ensureDir,
  exists,
  readJsonIfExists,
  plainObject,
} from './util.js'
import {
  applyPlanUnlocked,
  bindWorkspace,
  createProject,
  emptyState,
  isMemoryRoot,
  loadMemory,
  memoryPaths,
  resolvePath,
  withLock,
} from './store.js'
import { renderMarkdownFiles } from './render.js'

/**
 * @param {{ memoryDir?: string, cwd?: string, config?: Record<string, any>, args?: Record<string, any> }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function initMemory(input = {}) {
  const cwd = input.cwd || process.cwd()
  const config = plainObject(input.config)
  const args = plainObject(input.args)
  const rawDir =
    typeof args.memoryDir === 'string' && args.memoryDir.trim() !== ''
      ? args.memoryDir
      : typeof config.memoryDir === 'string' && config.memoryDir.trim() !== ''
        ? config.memoryDir
        : ''
  if (rawDir === '') {
    throw new Error(
      'novel_init 需要一个记忆库目录。例如：\n' +
        '  novel_init({ memoryDir: "D:\\\\小说\\\\我的作品-记忆库", title: "我的作品" })',
    )
  }
  const root = resolvePath(rawDir, cwd)
  await ensureDir(root)
  const paths = memoryPaths(root)

  const existing = await readJsonIfExists(paths.project)
  if (existing) {
    if (existing.kind !== 'dsh-novel-memory') {
      throw new Error('目标目录已有 project.json，但它不是 dsh-novel-memory 记忆库：' + root)
    }
    const memory = await loadMemory(root)
    const bind = args.bind !== false
    let binding = null
    if (bind) binding = await bindWorkspace(cwd, root, memory.project.title)
    return {
      created: false,
      bound: Boolean(binding),
      bindingFile: binding,
      memoryDir: root,
      title: memory.project.title,
      chapterCount: memory.state.chapters.length,
      text: `记忆库已存在：${root}\n标题：${memory.project.title}\n已提交章节：${memory.state.chapters.length}${binding ? '\n已绑定到当前工作区：' + binding : ''}`,
    }
  }

  // Do not adopt a folder that already contains our data but lost project.json:
  // writing a fresh project over it would silently orphan the old chapters.
  if (await exists(paths.state)) {
    throw new Error(
      '目标目录已有 state/current.json，但缺少 project.json。\n' +
        '为避免覆盖旧数据，请换一个空目录，或先修复/备份原记忆库：' + root,
    )
  }

  const project = createProject({
    title: args.title,
    genre: args.genre,
    language: args.language,
    style: args.style,
    synopsis: args.synopsis,
  })
  const state = emptyState()
  const markdownFiles = renderMarkdownFiles(state, project)
  const files = [
    { path: 'project.json', content: JSON.stringify(project, null, 2) + '\n' },
    { path: 'state/current.json', content: JSON.stringify(state, null, 2) + '\n' },
    ...markdownFiles,
    { path: '.novel-memory/ledger.jsonl', content: '' },
    { path: 'history/commits/.gitkeep', content: '' },
    { path: 'history/rolled-back/.gitkeep', content: '' },
  ]

  await withLock(root, async () => {
    await applyPlanUnlocked(root, { files, deletes: [] })
    await ensureDir(paths.characters)
    await ensureDir(paths.world)
    await ensureDir(paths.plot)
    await ensureDir(paths.arcs)
    await ensureDir(paths.chapters)
    await ensureDir(paths.commits)
    await ensureDir(paths.rolledBack)
  })

  const bind = args.bind !== false
  let binding = null
  let bindWarning = null
  if (bind) {
    try {
      binding = await bindWorkspace(cwd, root, project.title)
    } catch (error) {
      bindWarning = '记忆库已创建，但工作区绑定写入失败：' + String(error?.message ?? error)
    }
  }

  const text = [
    `已创建小说记忆库：${root}`,
    `标题：${project.title}`,
    `文件结构：characters/ · world/ · plot/arcs/ · chapters/ · state/current.json`,
    binding ? `已绑定到当前工作区：${binding}` : '未绑定工作区（下次调用工具时需要显式传 memoryDir）',
    bindWarning || '',
    '',
    '下一步：直接开始写第 1 章；写完后调用 novel_commit 提交正文和 changes。',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    created: true,
    bound: Boolean(binding),
    bindingFile: binding,
    bindWarning,
    memoryDir: root,
    title: project.title,
    chapterCount: 0,
    filesWritten: files.map((item) => item.path),
    text,
  }
}

/**
 * Bind an existing memory folder to the current workspace.
 *
 * @param {{ memoryDir?: string, cwd?: string, config?: Record<string, any> }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function useMemory(input = {}) {
  const cwd = input.cwd || process.cwd()
  const config = plainObject(input.config)
  const rawDir =
    typeof input.memoryDir === 'string' && input.memoryDir.trim() !== ''
      ? input.memoryDir
      : typeof config.memoryDir === 'string' && config.memoryDir.trim() !== ''
        ? config.memoryDir
        : ''
  if (rawDir === '') {
    throw new Error('novel_use 需要一个已存在的记忆库目录。例如：novel_use({ memoryDir: "D:\\\\小说\\\\我的作品-记忆库" })')
  }
  const root = resolvePath(rawDir, cwd)
  if (!(await isMemoryRoot(root))) {
    throw new Error('目标目录不是有效的 dsh-novel-memory 记忆库：' + root)
  }
  const memory = await loadMemory(root)
  const binding = await bindWorkspace(cwd, root, memory.project.title)
  return {
    bound: true,
    bindingFile: binding,
    memoryDir: root,
    title: memory.project.title,
    chapterCount: memory.state.chapters.length,
    text:
      `已绑定记忆库：${root}\n` +
      `标题：${memory.project.title} ｜ 已提交章节：${memory.state.chapters.length}\n` +
      `绑定文件：${binding}\n下一步：novel_context 读取第 ${memory.state.progress.lastChapter + 1} 章上下文。`,
  }
}
