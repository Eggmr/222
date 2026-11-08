/**
 * Roll back the most recent N commits by restoring the pre-commit snapshot.
 * This is the supported way to rewrite a chapter without corrupting the
 * timeline and character experiences.
 *
 * @module dsh-novel-memory/lib/rollback
 */

import path from 'node:path'
import { rename } from 'node:fs/promises'
import {
  clampInt,
  ensureDir,
  nowIso,
  readJsonIfExists,
  sha256,
  stableStringify,
} from './util.js'
import {
  applyPlanUnlocked,
  listCommitDirs,
  loadMemoryUnlocked,
  makeLedgerEntry,
  memoryPaths,
  normalizeState,
  readLedger,
  serializeLedger,
  withLock,
} from './store.js'
import { arcFileId, characterFileId, renderMarkdownFiles } from './render.js'

/**
 * @param {{ memoryDir: string, steps?: number, dryRun?: boolean, reason?: string }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function rollbackMemory(input) {
  const root = path.resolve(input.memoryDir)
  return withLock(root, async () => {
    const memory = await loadMemoryUnlocked(root)
    const paths = memoryPaths(root)
    const steps = clampInt(input.steps, 1, 1, 20)
    const commits = (await listCommitDirs(root)).filter(
      (commit) => Number(commit.meta.chapter) <= Number(memory.state.progress.lastChapter),
    )
    if (commits.length === 0) {
      throw new Error('没有可回滚的提交记录。')
    }
    if (steps > commits.length) {
      throw new Error(`最多只能回滚 ${commits.length} 次提交，收到 steps=${steps}。`)
    }
    const targets = commits.slice(-steps)
    const earliest = targets[0]
    const beforeStateRaw = await readJsonIfExists(path.join(earliest.dir, 'before-state.json'))
    const beforeProject = await readJsonIfExists(path.join(earliest.dir, 'before-project.json'))
    if (!beforeStateRaw || !beforeProject) {
      throw new Error('提交快照不完整，无法回滚：' + earliest.dir)
    }
    const beforeState = normalizeState(beforeStateRaw)
    const restoredChapter = Number(beforeState.progress.lastChapter) || 0
    const deletedChapters = targets
      .map((target) => ({
        chapter: Number(target.meta.chapter),
        file: memory.state.chapters.find((item) => item.number === Number(target.meta.chapter))?.file ?? '',
      }))
      .filter((item) => item.file !== '')

    const currentViews = [
      ...Object.values(memory.state.characters).map((character) => 'characters/' + characterFileId(character) + '.md'),
      ...Object.values(memory.state.arcs).map((arc) => 'plot/arcs/' + arcFileId(arc) + '.md'),
    ]
    const restoredViews = new Set([
      ...Object.values(beforeState.characters).map((character) => 'characters/' + characterFileId(character) + '.md'),
      ...Object.values(beforeState.arcs).map((arc) => 'plot/arcs/' + arcFileId(arc) + '.md'),
    ])
    const staleViewFiles = currentViews.filter((file) => !restoredViews.has(file))

    const ledger = await readLedger(root)
    if (ledger.some((entry) => entry.__corrupt)) {
      throw new Error('审计日志损坏，先修复 ledger.jsonl 再回滚。')
    }
    const prevHash = ledger.length ? String(ledger.at(-1).hash ?? 'GENESIS') : 'GENESIS'
    const entry = makeLedgerEntry({
      seq: ledger.length + 1,
      type: 'rollback',
      chapter: restoredChapter,
      title: '回滚 ' + targets.length + ' 次提交',
      contentHash: null,
      stateHash: sha256(stableStringify(beforeState)),
      prevHash,
      rolledBackChapters: targets.map((target) => Number(target.meta.chapter)),
      reason: typeof input.reason === 'string' ? input.reason : '',
    })
    const ledgerText = serializeLedger(ledger, entry)

    const files = [
      { path: 'project.json', content: JSON.stringify(beforeProject, null, 2) + '\n' },
      { path: 'state/current.json', content: JSON.stringify(beforeState, null, 2) + '\n' },
      ...renderMarkdownFiles(beforeState, beforeProject),
      { path: '.novel-memory/ledger.jsonl', content: ledgerText },
    ]

    const summary = {
      dryRun: input.dryRun === true,
      memoryDir: root,
      restoredChapter,
      rolledBackChapters: targets.map((target) => Number(target.meta.chapter)),
      deletedChapterFiles: deletedChapters.map((item) => item.file),
      deletedViewFiles: staleViewFiles,
      snapshot: earliest.dir,
      warnings: [],
      text: [
        `准备回滚 ${targets.length} 次提交：第 ${targets.map((target) => target.meta.chapter).join('、')} 章。`,
        `恢复后的进度：第 ${restoredChapter} 章。`,
        `将删除正文文件：${deletedChapters.map((item) => item.file).join('、') || '（无）'}`,
        staleViewFiles.length ? `将删除回滚后不再存在的人物/世界线视图：${staleViewFiles.join('、')}` : '',
        input.dryRun === true ? '这是 dryRun，尚未写入。' : '回滚完成后可重新提交这些章节。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
    if (input.dryRun === true) return summary

    await applyPlanUnlocked(root, {
      files,
      deletes: [...deletedChapters.map((item) => item.file), ...staleViewFiles],
    })

    // Move old commit snapshots out of the active history only after the state
    // write succeeds. A crash before this leaves them harmless because future
    // rollback selection filters by `chapter <= progress.lastChapter`.
    const stamp = nowIso().replace(/[:.]/g, '-')
    const trash = path.join(paths.rolledBack, stamp)
    await ensureDir(trash)
    const moved = []
    for (const target of targets) {
      const destination = path.join(trash, target.name)
      try {
        await rename(target.dir, destination)
        moved.push(path.relative(root, destination))
      } catch (error) {
        summary.warnings.push('提交快照移动失败（数据已回滚）：' + target.name + '：' + String(error?.message ?? error))
      }
    }
    summary.movedCommitDirs = moved
    summary.ledgerSeq = entry.seq
    summary.text =
      `已回滚 ${targets.length} 次提交，恢复到第 ${restoredChapter} 章。\n` +
      `已删除正文：${deletedChapters.map((item) => item.file).join('、') || '（无）'}\n` +
      (staleViewFiles.length ? `已删除过期视图：${staleViewFiles.join('、')}\n` : '') +
      `旧快照已移动到：${path.relative(root, trash)}\n` +
      '现在可以重新调用 novel_commit 提交修正后的章节。'
    return summary
  })
}
