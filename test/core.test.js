/**
 * Core memory-store tests. These exercise the filesystem modules directly so
 * they do not require a running DeepSeek Harness instance.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initMemory, useMemory } from '../lib/init.js'
import { commitChapter } from '../lib/commit.js'
import { buildContext } from '../lib/context.js'
import { searchMemory } from '../lib/search.js'
import { getStatus } from '../lib/status.js'
import { rollbackMemory } from '../lib/rollback.js'
import {
  applyPlan,
  loadMemory,
  makeLedgerEntry,
  memoryPaths,
  readLedger,
  resolveMemoryDir,
  withLock,
} from '../lib/store.js'
import { readJson } from '../lib/util.js'

const PROSE_1 = [
  '雪落在青石镇的屋檐上。林砚推开藏剑阁的门，看见苏婉正把一盏灯放在案角。',
  '“师父改过剑谱。”林砚低声说。他没有回头，指尖压在缺了一页的剑谱上。',
  '苏婉沉默了很久，最后只把灯芯挑亮了一点。窗外更鼓响过三声，谁都没有先走。',
].join('\n')

const PROSE_2 = [
  '北境官道的风像刀子。林砚把半部剑谱裹在怀里，走了整整一夜。',
  '天亮时，他在路边的废驿里看见一枚熟悉的剑穗，绳结是苏婉的手法。',
  '他没有回头，只把剑穗收进袖中，继续向北。',
].join('\n')

const SUMMARY_1 =
  '林砚在藏剑阁发现师父篡改剑谱，质问未果；苏婉选择留在师门，两人之间出现裂痕。林砚带走半部剑谱，决定前往北境。'
const SUMMARY_2 =
  '林砚冒雪北上，在北境废驿发现苏婉留下的剑穗，确认她并非完全站在师门一边，但两人仍未见面。'

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ root: string, workspace: string, memoryDir: string }>}
 */
async function makeProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-novel-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const workspace = path.join(root, 'workspace')
  const memoryDir = path.join(root, 'memory')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace, { recursive: true })
  const result = await initMemory({
    cwd: workspace,
    config: {},
    args: {
      memoryDir,
      title: '青石镇',
      genre: '仙侠',
      style: '克制、重视人物动机',
      synopsis: '一个被逐出师门的剑客追查剑谱真相。',
    },
  })
  assert.equal(result.created, true)
  return { root, workspace, memoryDir }
}

/**
 * @param {string} memoryDir
 * @param {number} [chapter]
 * @returns {Promise<Record<string, any>>}
 */
async function commitFirst(memoryDir, chapter = 1) {
  return commitChapter({
    memoryDir,
    args: {
      chapter,
      title: chapter === 1 ? '藏剑阁' : '北境官道',
      content: chapter === 1 ? PROSE_1 : PROSE_2,
      summary: chapter === 1 ? SUMMARY_1 : SUMMARY_2,
      timelinePosition: chapter === 1 ? '第一年冬，腊月初七' : '第一年冬，腊月初九',
      nextHooks:
        chapter === 1
          ? ['半部剑谱在第三重后出现反噬', '苏婉的剑穗出现在北境']
          : ['剑穗的主人就在前面的驿站'],
      changes: {
        characters:
          chapter === 1
            ? [
                {
                  name: '林砚',
                  role: '主角',
                  status: '受伤',
                  location: '青石镇',
                  mood: '愤怒但克制',
                  profile: {
                    personality: '外冷内热，重承诺；被背叛后更难信任他人',
                    motivation: '查清剑谱真相，证明师父的罪名',
                    abilities: '青石剑法第三重；半部剑谱只能练到第三重',
                  },
                  relationships: [
                    {
                      target: '苏婉',
                      type: '同门/决裂',
                      note: '苏婉选择留在师门，林砚没有回头',
                    },
                  ],
                  experiences: ['在藏剑阁发现师父篡改剑谱', '被师父当众逐出师门，带走半部剑谱'],
                },
                {
                  name: '苏婉',
                  role: '重要配角',
                  status: '存活',
                  location: '青石镇',
                  profile: { personality: '温和、谨慎，关键时刻有自己的判断' },
                  relationships: [
                    {
                      target: '林砚',
                      type: '同门/决裂',
                      note: '没有跟随林砚离开，但暗中保留了他的剑穗',
                    },
                  ],
                },
              ]
            : [
                {
                  name: '林砚',
                  status: '受伤',
                  location: '北境废驿',
                  mood: '警觉',
                  relationships: [
                    {
                      target: '苏婉',
                      type: '同门/决裂',
                      note: '确认苏婉暗中留了剑穗，态度开始松动',
                    },
                  ],
                  experiences: ['在北境废驿发现苏婉留下的剑穗'],
                },
                {
                  name: '苏婉',
                  status: '存活',
                  location: '青石镇',
                  experiences: ['暗中把剑穗留在北境废驿'],
                },
                {
                  name: '驿丞',
                  role: '路人',
                  status: '存活',
                  location: '北境废驿',
                  profile: { personality: '胆小怕事，但记得每一个过路人的脸' },
                  experiences: ['告诉林砚剑穗是两天前一个女剑客留下的'],
                },
              ],
        world: {
          overview: '青石镇以剑派立镇，北境是流放者的荒原。',
          rules: [
            {
              title: '剑谱禁制',
              text: '完整剑谱需要师徒血誓同时开启；半部剑谱只能练到第三重。',
            },
          ],
          locations: [
            { name: '青石镇', description: '剑派聚居的山镇，冬季多雪。' },
            { name: '北境官道', description: '通往北境的官道，冬季常有流寇。' },
          ],
          factions: [{ name: '青石剑派', description: '镇上的剑派，掌门是林砚的师父。' }],
          items: [{ name: '半部剑谱', description: '缺页的剑谱，只能练到第三重。' }],
        },
        arcs:
          chapter === 1
            ? [
                { name: '青石镇篇', status: '进行中', summary: '林砚在青石镇拜师、发现剑谱被篡改、被逐出师门。' },
                { name: '北境篇', status: '未开始', summary: '林砚前往北境寻找解开禁制的人。' },
              ]
            : [{ name: '北境篇', status: '进行中', summary: '林砚带着半部剑谱前往北境。' }],
        threads:
          chapter === 1
            ? [
                {
                  title: '剑谱篡改真相',
                  status: 'open',
                  description: '师父为什么篡改剑谱？完整剑谱的另一半在哪里？',
                  relatedCharacters: ['林砚', '师父'],
                },
              ]
            : [],
        foreshadowing:
          chapter === 1
            ? [{ text: '林砚带走的是半部剑谱，只能练到第三重', status: 'planted' }]
            : [],
        timeline:
          chapter === 1
            ? [
                {
                  time: '腊月初七黄昏',
                  location: '藏剑阁',
                  characters: ['林砚', '苏婉', '师父'],
                  event: '林砚发现剑谱被篡改，与师父对峙',
                  consequences: '被逐出师门，带半部剑谱离开',
                },
              ]
            : [
                {
                  time: '腊月初九清晨',
                  location: '北境废驿',
                  characters: ['林砚'],
                  event: '林砚发现苏婉留下的剑穗',
                  consequences: '确认苏婉暗中相助',
                },
              ],
      },
    },
  })
}

test('init creates the folder structure and binds the workspace', async (t) => {
  const { root, workspace, memoryDir } = await makeProject(t)
  const paths = memoryPaths(memoryDir)
  for (const file of [
    paths.project,
    paths.state,
    paths.readme,
    path.join(paths.characters, '_index.md'),
    path.join(paths.world, 'overview.md'),
    path.join(paths.world, 'rules.md'),
    path.join(paths.plot, 'timeline.md'),
    path.join(paths.plot, 'threads.md'),
    path.join(paths.plot, 'chapter-index.md'),
    path.join(paths.arcs, '_index.md'),
    paths.ledger,
  ]) {
    assert.equal(existsSync(file), true, 'missing ' + file)
  }
  const project = await readJson(paths.project)
  assert.equal(project.kind, 'dsh-novel-memory')
  assert.equal(project.title, '青石镇')
  assert.equal(project.schemaVersion, 1)

  const binding = await readJson(path.join(workspace, '.dsh-novel.json'))
  assert.equal(binding.kind, 'dsh-novel-memory-binding')
  assert.equal(path.resolve(binding.memoryDir), path.resolve(memoryDir))

  const second = await initMemory({ cwd: workspace, args: { memoryDir } })
  assert.equal(second.created, false)
  assert.equal(second.chapterCount, 0)

  const otherWorkspace = path.join(root, 'other')
  await import('node:fs/promises').then((fs) => fs.mkdir(otherWorkspace, { recursive: true }))
  const used = await useMemory({ memoryDir, cwd: otherWorkspace })
  assert.equal(used.bound, true)
  assert.equal(existsSync(path.join(otherWorkspace, '.dsh-novel.json')), true)
})

test('commit writes prose, merges changes, rebuilds views and appends a hashed ledger', async (t) => {
  const { memoryDir } = await makeProject(t)
  const result = await commitFirst(memoryDir)
  assert.equal(result.alreadyCommitted, false)
  assert.equal(result.chapter, 1)
  assert.equal(result.ledgerSeq, 1)
  assert.equal(typeof result.contentHash, 'string')
  assert.equal(typeof result.stateHash, 'string')
  assert.ok(result.filesWritten.includes('state/current.json'))
  assert.ok(result.filesWritten.includes('chapters/0001-藏剑阁.md'))

  const memory = await loadMemory(memoryDir)
  const { state, project } = memory
  assert.equal(state.progress.lastChapter, 1)
  assert.equal(state.progress.lastChapterTitle, '藏剑阁')
  assert.equal(state.progress.timelinePosition, '第一年冬，腊月初七')
  assert.equal(state.chapters.length, 1)
  assert.equal(state.chapters[0].hash, result.contentHash)
  assert.equal(project.updatedAt, state.chapters[0].committedAt)

  assert.equal(Object.keys(state.characters).length, 2)
  const lin = Object.values(state.characters).find((character) => character.name === '林砚')
  assert.ok(lin)
  assert.equal(lin.role, '主角')
  assert.equal(lin.status, '受伤')
  assert.equal(lin.location, '青石镇')
  assert.equal(lin.relationships.length, 1)
  const su = Object.values(state.characters).find((character) => character.name === '苏婉')
  assert.ok(su)
  assert.equal(lin.relationships[0].target, su.id)
  assert.equal(lin.relationships[0].type, '同门/决裂')
  assert.equal(lin.experiences.length, 2)

  assert.equal(state.world.rules.length, 1)
  assert.equal(state.world.rules[0].title, '剑谱禁制')
  assert.equal(state.world.locations.length, 2)
  assert.equal(state.world.factions.length, 1)
  assert.equal(state.world.items.length, 1)

  assert.ok(state.arcs.main)
  const qingshi = Object.values(state.arcs).find((arc) => arc.name === '青石镇篇')
  assert.ok(qingshi)
  assert.deepEqual(qingshi.chapters, [1])
  const north = Object.values(state.arcs).find((arc) => arc.name === '北境篇')
  assert.ok(north)
  assert.equal(north.status, '未开始')
  assert.equal(north.chapters.length, 0)

  assert.equal(state.threads.length, 1)
  assert.equal(state.threads[0].status, 'open')
  assert.equal(state.foreshadowing.length, 1)
  assert.equal(state.timeline.length, 1)
  assert.deepEqual(state.nextHooks, ['半部剑谱在第三重后出现反噬', '苏婉的剑穗出现在北境'])

  const chapterFile = await readFile(path.join(memoryDir, 'chapters/0001-藏剑阁.md'), 'utf8')
  assert.match(chapterFile, /^# 第 1 章 藏剑阁/)
  assert.ok(chapterFile.includes(PROSE_1))
  const linFile = await readFile(path.join(memoryDir, 'characters/林砚.md'), 'utf8')
  assert.ok(linFile.includes('外冷内热'))
  assert.ok(linFile.includes('| 苏婉 | 同门/决裂 |'))
  const threadsFile = await readFile(path.join(memoryDir, 'plot/threads.md'), 'utf8')
  assert.ok(threadsFile.includes('剑谱篡改真相'))
  const arcFile = await readFile(path.join(memoryDir, 'plot/arcs/青石镇篇.md'), 'utf8')
  assert.ok(arcFile.includes('第 1 章'))

  const ledger = await readLedger(memoryDir)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].type, 'commit')
  assert.equal(ledger[0].chapter, 1)
  assert.equal(ledger[0].prevHash, 'GENESIS')
  const { hash, ...rest } = ledger[0]
  assert.equal(makeLedgerEntry(rest).hash, hash)

  const commits = await readdir(path.join(memoryDir, 'history/commits'))
  assert.ok(commits.some((name) => /^\d+-ch-0001$/.test(name)))
})

test('committing the same chapter and prose is idempotent, different prose is rejected', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const repeat = await commitChapter({
    memoryDir,
    args: { chapter: 1, title: '藏剑阁', content: PROSE_1, summary: SUMMARY_1 },
  })
  assert.equal(repeat.alreadyCommitted, true)
  assert.equal((await readLedger(memoryDir)).length, 1)
  const memory = await loadMemory(memoryDir)
  assert.equal(memory.state.chapters.length, 1)

  await assert.rejects(
    () =>
      commitChapter({
        memoryDir,
        args: { chapter: 1, title: '另一个版本', content: PROSE_1 + '\n改动', summary: SUMMARY_1 },
      }),
    /已经提交过/,
  )
})

test('dryRun validates without writing', async (t) => {
  const { memoryDir } = await makeProject(t)
  const preview = await commitChapter({
    memoryDir,
    args: {
      chapter: 1,
      title: '藏剑阁',
      content: PROSE_1,
      summary: SUMMARY_1,
      dryRun: true,
      changes: { characters: [{ name: '林砚', role: '主角', status: '存活' }] },
    },
  })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.chapter, 1)
  const memory = await loadMemory(memoryDir)
  assert.equal(memory.state.progress.lastChapter, 0)
  assert.equal(memory.state.chapters.length, 0)
  assert.equal(existsSync(path.join(memoryDir, 'chapters/0001-藏剑阁.md')), false)
  assert.equal((await readLedger(memoryDir)).length, 0)
})

test('chapter numbers must be contiguous unless allowGap is set', async (t) => {
  const { memoryDir } = await makeProject(t)
  await assert.rejects(
    () => commitChapter({ memoryDir, args: { chapter: 3, content: PROSE_1, summary: SUMMARY_1 } }),
    /章节号不连续/,
  )
  const jumped = await commitChapter({
    memoryDir,
    args: { chapter: 3, content: PROSE_1, summary: SUMMARY_1, allowGap: true },
  })
  assert.equal(jumped.chapter, 3)
  assert.ok(jumped.warnings.some((warning) => warning.includes('跳章')))
})

test('context pack contains canon, open threads and the previous chapter', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const context = await buildContext({
    memoryDir,
    chapter: 2,
    characters: ['林砚'],
    query: '北境',
    recentChapters: 3,
  })
  assert.equal(context.chapter, 2)
  assert.equal(context.lastChapter, 1)
  assert.ok(context.includedCharacters.includes('林砚'))
  assert.ok(context.text.includes('林砚'))
  assert.ok(context.text.includes('苏婉'))
  assert.ok(context.text.includes('剑谱篡改真相'))
  assert.ok(context.text.includes('半部剑谱'))
  assert.ok(context.text.includes('上一章正文'))
  assert.ok(context.text.includes('藏剑阁'))
  assert.ok(context.text.includes('novel_commit'))
  assert.ok(context.sections.includes('任务与铁律'))
  assert.ok(context.sections.includes('当前人物状态（必须遵守）'))
  assert.equal(context.warnings.length, 0)
})

test('context warns when asked to rewrite an already committed chapter and respects the budget', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const rewrite = await buildContext({ memoryDir, chapter: 1 })
  assert.ok(rewrite.warnings.some((warning) => warning.includes('已提交')))

  const huge = PROSE_1 + '\n' + '雪'.repeat(40000)
  const locations = Array.from({ length: 30 }, (_, index) => ({
    name: '北境地点' + (index + 1),
    description: '这是一段很长的地点描述。'.repeat(40),
  }))
  await commitChapter({
    memoryDir,
    args: {
      chapter: 2,
      title: '长章',
      content: huge,
      summary: SUMMARY_2,
      changes: { world: { locations } },
    },
  })
  const tight = await buildContext({ memoryDir, chapter: 3, maxChars: 4000 })
  assert.ok(tight.chars < 20000, 'context should be truncated, got ' + tight.chars)
  assert.ok(tight.text.includes('上一章正文'))
  assert.ok(tight.omittedSections.includes('地点 / 势力 / 物品'))
  assert.ok(tight.text.includes('已省略'))
})

test('search finds canon, prose and missing terms', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const all = await searchMemory({ memoryDir, query: '剑谱', scope: 'all', limit: 20 })
  assert.ok(all.total > 0)
  assert.ok(all.results.some((result) => result.category === '世界规则'))
  assert.ok(all.results.some((result) => result.category === '线索'))
  const prose = await searchMemory({ memoryDir, query: '更鼓', scope: 'chapters' })
  assert.equal(prose.results[0].category, '正文')
  assert.match(prose.results[0].file, /^chapters\/0001-/)
  const none = await searchMemory({ memoryDir, query: '不存在的词', scope: 'all' })
  assert.equal(none.total, 0)
})

test('status detects missing views and repair rebuilds them', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const healthy = await getStatus({ memoryDir })
  assert.equal(healthy.healthy, true)
  assert.equal(healthy.issues.filter((issue) => issue.level === 'error').length, 0)

  await rm(path.join(memoryDir, 'characters/林砚.md'))
  const broken = await getStatus({ memoryDir })
  assert.ok(broken.issues.some((issue) => issue.code === 'CHARACTER_VIEW_MISSING'))
  const repaired = await getStatus({ memoryDir, repair: true })
  assert.equal(existsSync(path.join(memoryDir, 'characters/林砚.md')), true)
  assert.ok(repaired.repairedFiles.includes('characters/林砚.md'))
})

test('status detects a tampered ledger entry', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  const ledgerFile = memoryPaths(memoryDir).ledger
  const raw = await readFile(ledgerFile, 'utf8')
  const entry = JSON.parse(raw.trim())
  entry.summary = '被篡改的摘要'
  await writeFile(ledgerFile, JSON.stringify(entry) + '\n', 'utf8')
  const status = await getStatus({ memoryDir })
  assert.equal(status.healthy, false)
  assert.ok(status.issues.some((issue) => issue.code === 'LEDGER_HASH_MISMATCH'))
})

test('rollback restores the previous snapshot and allows a rewrite', async (t) => {
  const { memoryDir } = await makeProject(t)
  await commitFirst(memoryDir)
  await commitFirst(memoryDir, 2)

  const preview = await rollbackMemory({ memoryDir, steps: 1, dryRun: true })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.restoredChapter, 1)
  assert.equal((await loadMemory(memoryDir)).state.progress.lastChapter, 2)

  const rolled = await rollbackMemory({ memoryDir, steps: 1, reason: '重写第 2 章' })
  assert.equal(rolled.restoredChapter, 1)
  assert.ok(rolled.deletedChapterFiles.some((file) => file.includes('0002-')))
  const memory = await loadMemory(memoryDir)
  assert.equal(memory.state.progress.lastChapter, 1)
  assert.equal(memory.state.chapters.length, 1)
  assert.equal(existsSync(path.join(memoryDir, 'chapters/0002-北境官道.md')), false)
  assert.ok(rolled.deletedViewFiles.includes('characters/驿丞.md'))
  assert.equal(existsSync(path.join(memoryDir, 'characters/驿丞.md')), false)

  const ledger = await readLedger(memoryDir)
  assert.equal(ledger.length, 3)
  assert.equal(ledger[2].type, 'rollback')
  assert.deepEqual(ledger[2].rolledBackChapters, [2])

  const rewrite = await commitChapter({
    memoryDir,
    args: {
      chapter: 2,
      title: '北境官道（重写）',
      content: PROSE_2 + '\n他握紧了剑穗。',
      summary: SUMMARY_2,
      changes: { characters: [{ name: '林砚', status: '存活', location: '北境废驿' }] },
    },
  })
  assert.equal(rewrite.chapter, 2)
  assert.equal((await loadMemory(memoryDir)).state.progress.lastChapter, 2)
})

test('resolveMemoryDir uses the workspace binding and rejects unknown folders', async (t) => {
  const { root, workspace, memoryDir } = await makeProject(t)
  const resolved = await resolveMemoryDir({ cwd: workspace })
  assert.equal(path.resolve(resolved.memoryDir), path.resolve(memoryDir))
  assert.match(resolved.source, /工作区绑定/)

  const empty = path.join(root, 'empty-workspace')
  await import('node:fs/promises').then((fs) => fs.mkdir(empty, { recursive: true }))
  await assert.rejects(() => resolveMemoryDir({ cwd: empty }), /还没有绑定/)
  await assert.rejects(
    () => resolveMemoryDir({ cwd: workspace, memoryDir: path.join(root, 'not-a-memory') }),
    /不是有效记忆库/,
  )
})

test('journal path traversal is rejected', async (t) => {
  const { root, memoryDir } = await makeProject(t)
  await assert.rejects(
    () => applyPlan(memoryDir, { files: [{ path: '../escape.txt', content: 'x' }] }),
    /路径越界/,
  )
  await assert.rejects(
    () => applyPlan(memoryDir, { files: [{ path: '..\\escape.txt', content: 'x' }] }),
    /路径越界/,
  )
  await assert.rejects(
    () => applyPlan(memoryDir, { deletes: [path.join(root, 'absolute.txt')] }),
    /路径越界/,
  )
  assert.equal(existsSync(path.join(root, 'escape.txt')), false)
})

test('a leftover journal is replayed on the next locked read', async (t) => {
  const { memoryDir } = await makeProject(t)
  const paths = memoryPaths(memoryDir)
  const target = path.join(memoryDir, 'world', 'recovered.md')
  await writeFile(
    paths.journal,
    JSON.stringify({
      version: 1,
      id: 'crash-test',
      createdAt: new Date().toISOString(),
      files: [{ path: 'world/recovered.md', content: '# recovered\n' }],
      deletes: [],
    }),
    'utf8',
  )
  await loadMemory(memoryDir)
  assert.equal(await readFile(target, 'utf8'), '# recovered\n')
  assert.equal(existsSync(paths.journal), false)

  await writeFile(paths.journal, '{"version":1,"files":', 'utf8')
  await assert.rejects(() => loadMemory(memoryDir), /journal|JSON/i)
})

test('concurrent lock holders are serialized', async (t) => {
  const { memoryDir } = await makeProject(t)
  const order = []
  await Promise.all([
    withLock(memoryDir, async () => {
      order.push('a-start')
      await new Promise((resolve) => setTimeout(resolve, 80))
      order.push('a-end')
    }),
    withLock(memoryDir, async () => {
      order.push('b-start')
      order.push('b-end')
    }),
  ])
  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end'])
})
