/**
 * dsh-novel-memory — a DeepSeek Harness plugin that gives the model a durable,
 * self-updating novel memory folder.
 *
 * Tools:
 *   novel_init / novel_use  — choose and bind a memory folder
 *   novel_context           — read canon + last chapter before writing
 *   novel_commit            — append chapter and update every memory file
 *   novel_status            — inspect / repair the memory folder
 *   novel_search            — keyword lookup across canon and prose
 *   novel_rollback          — undo the most recent commits safely
 *
 * A runtime skill teaches the model the read → write → commit loop.
 *
 * @module dsh-novel-memory
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { initMemory, useMemory } from './lib/init.js'
import { buildContext } from './lib/context.js'
import { commitChapter } from './lib/commit.js'
import { getStatus } from './lib/status.js'
import { searchMemory } from './lib/search.js'
import { rollbackMemory } from './lib/rollback.js'
import { DEFAULT_MAX_CONTEXT_CHARS, resolveMemoryDir } from './lib/store.js'
import { clampInt, plainObject } from './lib/util.js'

export const name = 'novel-memory'
export const inject = ['tools']

const SKILL_FILE = fileURLToPath(new URL('./skills/novel-memory/SKILL.md', import.meta.url))
const SKILL_NAME = 'novel-memory'
const SKILL_DESCRIPTION = '长篇小说记忆库：写前读取人物/世界观/世界线，写后回写正文与状态，保证下一章不崩逻辑。'

/**
 * @param {unknown} config
 * @returns {{ memoryDir: string, maxContextChars: number }}
 */
function normalizeConfig(config) {
  const raw = plainObject(config)
  return {
    memoryDir: typeof raw.memoryDir === 'string' ? raw.memoryDir.trim() : '',
    maxContextChars: clampInt(raw.maxContextChars, DEFAULT_MAX_CONTEXT_CHARS, 4000, 200000),
  }
}

/**
 * @param {any} exec
 * @returns {string}
 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
}

/**
 * @param {any} exec
 */
function assertNotAborted(exec) {
  if (exec?.signal?.aborted) throw new Error('操作已取消')
}

/**
 * @param {any} value
 * @returns {Array<{ type: 'text', text: string }>}
 */
function renderText(value) {
  return [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }]
}

const memoryDirParam = {
  type: 'string',
  description: '记忆库根目录（绝对路径，或相对当前工作区）。省略时使用工作区绑定 .dsh-novel.json / 插件配置。',
}

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => renderText(value),
}

const characterUpdateSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    id: { type: 'string', description: '已有角色的稳定 ID；新角色可省略' },
    name: { type: 'string', description: '角色姓名（必填，按姓名/别名/ID 匹配已有角色）' },
    aliases: { type: 'array', items: { type: 'string' }, description: '别名、称呼、化名' },
    role: { type: 'string', description: '主角 / 反派 / 重要配角 / 配角 / 路人' },
    status: { type: 'string', description: '存活 / 受伤 / 失踪 / 死亡 / 已退场 等' },
    location: { type: 'string', description: '本章结束时所在位置' },
    mood: { type: 'string', description: '本章结束时的情绪/心理状态' },
    notes: { type: 'string', description: '其他需要长期记住的备注' },
    profile: {
      type: 'object',
      additionalProperties: true,
      properties: {
        personality: { type: 'string', description: '性格（用整合后的描述，覆盖旧值）' },
        appearance: { type: 'string', description: '外貌' },
        background: { type: 'string', description: '出身与过往' },
        motivation: { type: 'string', description: '动机与目标' },
        abilities: { type: 'string', description: '能力、功法、底牌与限制' },
        arc: { type: 'string', description: '人物弧光/成长阶段' },
      },
    },
    relationships: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          target: { type: 'string', description: '关系对象姓名/ID（必填）' },
          type: { type: 'string', description: '关系类型，如师徒、宿敌、恋人、上下级' },
          note: { type: 'string', description: '关系说明与当前张力' },
          attitude: { type: 'string', description: '当前态度' },
          targetType: { type: 'string', enum: ['character', 'other'], description: '对象是人物还是势力/其他；other 不自动建人物' },
          createTarget: { type: 'boolean', description: '对象不存在时是否自动建一个“未登场”人物占位，默认 true' },
          remove: { type: 'boolean', description: 'true 表示删除这条关系' },
        },
      },
    },
    experiences: {
      type: 'array',
      items: { type: 'string' },
      description: '本章新增的重要经历（会标上当前章号；不要重复旧经历）',
    },
  },
}

const changesSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    characters: {
      type: 'array',
      items: characterUpdateSchema,
      description: '人物状态/性格/关系/经历变化。只写正文中真实发生的变化。',
    },
    world: {
      type: 'object',
      additionalProperties: true,
      properties: {
        overview: { type: 'string', description: '世界总览（会覆盖旧值；不确定就省略）' },
        rules: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              title: { type: 'string', description: '规则名（必填）' },
              text: { type: 'string', description: '规则正文' },
              description: { type: 'string', description: '规则正文（text 的别名）' },
            },
          },
          description: '力量体系/世界规则，按 title 去重更新',
        },
        locations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', description: '地点名（必填）' },
              description: { type: 'string', description: '地点描述' },
            },
          },
        },
        factions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', description: '势力名（必填）' },
              description: { type: 'string', description: '势力描述' },
            },
          },
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              name: { type: 'string', description: '物品名（必填）' },
              description: { type: 'string', description: '物品描述' },
            },
          },
        },
      },
    },
    arcs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string', description: '已有篇章 ID；新篇章可省略' },
          name: { type: 'string', description: '篇章/世界线名（必填）' },
          status: { type: 'string', description: '进行中 / 已完结 / 未开始' },
          summary: { type: 'string', description: '本篇章概要（整合后覆盖）' },
          startChapter: { type: 'integer', description: '起始章' },
          endChapter: { type: 'integer', description: '结束章' },
        },
      },
      description: '新增或更新篇章/世界线；当前章会自动加入所有“进行中”的篇章',
    },
    threads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string', description: '已有线索 ID；新线索可省略' },
          title: { type: 'string', description: '线索标题（必填）' },
          status: { type: 'string', enum: ['open', 'closed'], description: 'open=未回收，closed=已回收' },
          description: { type: 'string', description: '线索内容/悬念' },
          resolution: { type: 'string', description: '回收方式（status=closed 时写）' },
          relatedCharacters: { type: 'array', items: { type: 'string' }, description: '相关人物姓名' },
        },
      },
    },
    foreshadowing: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          id: { type: 'string', description: '已有伏笔 ID；新伏笔可省略' },
          text: { type: 'string', description: '伏笔内容（必填）' },
          status: { type: 'string', enum: ['planted', 'paid-off', 'abandoned'], description: 'planted=未回收，paid-off=已回收，abandoned=已放弃' },
          payoff: { type: 'string', description: '回收方式' },
        },
      },
    },
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          time: { type: 'string', description: '故事内时间，如“第三天黄昏”' },
          location: { type: 'string', description: '地点' },
          characters: { type: 'array', items: { type: 'string' }, description: '在场人物' },
          event: { type: 'string', description: '发生了什么（必填）' },
          consequences: { type: 'string', description: '直接后果/状态变化' },
        },
      },
      description: '本章关键事件，供下一章时间线使用',
    },
  },
}

/**
 * Register tools, the workflow skill and the /novel command.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, any>} [config]
 * @returns {() => void}
 */
export function apply(ctx, config) {
  const settings = normalizeConfig(config)
  const disposers = []

  const skills = ctx.get('skills')
  if (skills && typeof skills.register === 'function') {
    try {
      disposers.push(
        skills.register({
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          content: readFileSync(SKILL_FILE, 'utf8'),
          source: 'runtime',
          provider: 'dsh-novel-memory',
        }),
      )
    } catch (error) {
      ctx.logger?.warn?.('dsh-novel-memory: failed to register skill: ' + String(error))
    }
  }

  const commands = ctx.get('commands')
  if (commands && typeof commands.register === 'function') {
    disposers.push(
      commands.register({
        name: 'novel',
        description: '小说记忆库：/novel status | /novel context [章] | /novel init <目录> [标题] | /novel use <目录> | /novel help',
        input: { hint: 'status | context [章] | init <目录> [标题] | use <目录> | help' },
        async handler(invocation) {
          try {
            const cwd = invocation.agent?.session?.header?.cwd ?? process.cwd()
            const parsed = parseNovelCommand(invocation.rawInput)
            if (parsed.action === 'help' || parsed.action === '') {
              return { kind: 'success', text: novelHelp() }
            }
            if (parsed.action === 'init') {
              if (!parsed.path) throw new Error('用法：/novel init <记忆库目录> [标题]')
              const result = await initMemory({
                memoryDir: parsed.path,
                cwd,
                config: settings,
                args: { memoryDir: parsed.path, title: parsed.title || undefined, bind: true },
              })
              return { kind: 'success', text: result.text }
            }
            if (parsed.action === 'use') {
              if (!parsed.path) throw new Error('用法：/novel use <记忆库目录>')
              const result = await useMemory({ memoryDir: parsed.path, cwd, config: settings })
              return { kind: 'success', text: result.text }
            }
            const resolved = await resolveMemoryDir({ cwd, config: settings })
            if (parsed.action === 'status') {
              const result = await getStatus({ memoryDir: resolved.memoryDir })
              return { kind: 'success', text: result.text }
            }
            if (parsed.action === 'context') {
              const chapter = parsed.chapter
              const result = await buildContext({
                memoryDir: resolved.memoryDir,
                chapter,
                maxChars: settings.maxContextChars,
              })
              return { kind: 'success', text: result.text }
            }
            return { kind: 'error', text: '未知子命令：' + parsed.action + '\n\n' + novelHelp() }
          } catch (error) {
            return { kind: 'error', text: String(error?.message ?? error) }
          }
        },
      }),
    )
  }

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_init',
        description:
          '创建并绑定一个小说记忆库文件夹。会建立 characters/、world/、plot/arcs/、chapters/、state/current.json 等结构，' +
          '并写入工作区绑定 .dsh-novel.json。只应在用户选定目录后调用；已有记忆库不会被覆盖。',
        parameters: {
          memoryDir: { ...memoryDirParam, required: true, description: '要创建/使用的记忆库根目录（必填）' },
          title: { type: 'string', description: '小说标题' },
          genre: { type: 'string', description: '类型/题材' },
          language: { type: 'string', description: '语言，默认 zh-CN' },
          style: { type: 'string', description: '文风要求' },
          synopsis: { type: 'string', description: '故事简介' },
          bind: { type: 'boolean', description: '是否写入当前工作区绑定，默认 true' },
        },
        output,
        timeoutMs: 30000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          assertNotAborted(exec)
          return initMemory({
            memoryDir: args.memoryDir,
            cwd: sessionCwd(exec),
            config: settings,
            args,
          })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_use',
        description: '把当前工作区绑定到一个已经存在的 dsh-novel-memory 记忆库目录，之后调用其他工具可省略 memoryDir。',
        parameters: {
          memoryDir: { ...memoryDirParam, required: true, description: '已存在的记忆库根目录（必填）' },
        },
        output,
        timeoutMs: 30000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          assertNotAborted(exec)
          return useMemory({ memoryDir: args.memoryDir, cwd: sessionCwd(exec), config: settings })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_context',
        description:
          '写正文前必须调用。读取记忆库中的当前进度、人物性格/关系/状态、世界观、世界线、未回收线索伏笔、最近章节摘要和上一章正文，' +
          '组装成带硬性写作要求的只读上下文包。返回内容必须当作既成事实遵守。',
        parameters: {
          memoryDir: memoryDirParam,
          chapter: { type: 'integer', description: '准备写的章节号；省略时为下一章' },
          query: { type: 'string', description: '本次写作焦点/关键词，用于挑选相关人物' },
          characters: { type: 'array', items: { type: 'string' }, description: '需要重点读取的人物姓名；省略时自动选活跃人物' },
          recentChapters: { type: 'integer', description: '包含最近几章的摘要与时间线，默认 3' },
          includeLastChapter: { type: 'boolean', description: '是否包含上一章正文用于衔接，默认 true' },
          maxChars: { type: 'integer', description: '上下文最大字符数，默认使用插件配置' },
        },
        output,
        timeoutMs: 60000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          assertNotAborted(exec)
          const cwd = sessionCwd(exec)
          const resolved = await resolveMemoryDir({ memoryDir: args.memoryDir, cwd, config: settings })
          return buildContext({
            memoryDir: resolved.memoryDir,
            chapter: args.chapter,
            query: args.query,
            characters: args.characters,
            recentChapters: args.recentChapters,
            includeLastChapter: args.includeLastChapter,
            maxChars: args.maxChars ?? settings.maxContextChars,
            config: settings,
          })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_commit',
        description:
          '写完正文后必须调用。提交本章正文与摘要，并把正文中真实发生的人物变化、关系变化、世界观新增、世界线进度、线索/伏笔状态、时间线事件写入记忆库；' +
          '插件会原子更新 state/current.json、重建全部人物/世界/世界线 Markdown 子文件、写审计日志并留下可回滚快照。' +
          'changes 只记录已经写进正文的事实，不记录计划。重复提交同一章相同内容会幂等返回。',
        parameters: {
          memoryDir: memoryDirParam,
          chapter: { type: 'integer', description: '章节号；省略时自动接续 lastChapter + 1' },
          title: { type: 'string', description: '本章标题；省略时使用“未命名”' },
          content: { type: 'string', required: true, description: '本章正文全文（纯正文，不含标题/摘要）' },
          summary: { type: 'string', required: true, description: '本章摘要：发生了什么、人物状态如何变化、留下什么钩子（建议 100–300 字）' },
          changes: changesSchema,
          timelinePosition: { type: 'string', description: '本章结束时的故事内时间，如“第三天黄昏”' },
          nextHooks: { type: 'array', items: { type: 'string' }, description: '本章结尾留给下一章的钩子/悬念' },
          allowGap: { type: 'boolean', description: '允许章节号不连续（默认 false）' },
          dryRun: { type: 'boolean', description: '只校验和预览，不写入' },
        },
        output,
        timeoutMs: 180000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          assertNotAborted(exec)
          const cwd = sessionCwd(exec)
          const resolved = await resolveMemoryDir({ memoryDir: args.memoryDir, cwd, config: settings })
          return commitChapter({ memoryDir: resolved.memoryDir, args, config: settings })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_status',
        description:
          '检查小说记忆库健康状态：进度、人物/篇章/线索数量、章节文件与索引哈希、Markdown 视图缺失、审计日志哈希链、快照是否可回滚。' +
          'repair=true 时重建所有自动生成的 Markdown 视图（不会改正文）。',
        parameters: {
          memoryDir: memoryDirParam,
          repair: { type: 'boolean', description: '重建缺失/过期的自动 Markdown 视图，默认 false' },
        },
        output,
        timeoutMs: 60000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          assertNotAborted(exec)
          const cwd = sessionCwd(exec)
          const resolved = await resolveMemoryDir({ memoryDir: args.memoryDir, cwd, config: settings })
          return getStatus({ memoryDir: resolved.memoryDir, repair: args.repair === true })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_search',
        description:
          '在记忆库中按关键词搜索人物、关系、经历、世界观、时间线、线索、伏笔、章节摘要和正文。' +
          '当 novel_context 的预算省略了某部分，或需要确认“某人以前说过/做过什么”时使用。',
        parameters: {
          memoryDir: memoryDirParam,
          query: { type: 'string', required: true, description: '搜索关键词（支持中文子串）' },
          scope: { type: 'string', enum: ['all', 'characters', 'world', 'plot', 'chapters'], description: '搜索范围，默认 all' },
          limit: { type: 'integer', description: '最多返回多少条，默认 10，最大 50' },
        },
        output,
        timeoutMs: 60000,
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          assertNotAborted(exec)
          const cwd = sessionCwd(exec)
          const resolved = await resolveMemoryDir({ memoryDir: args.memoryDir, cwd, config: settings })
          return searchMemory({
            memoryDir: resolved.memoryDir,
            query: args.query,
            scope: args.scope,
            limit: args.limit,
          })
        },
      }),
    ),
  )

  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'novel_rollback',
        description:
          '回滚最近 N 次已提交章节：恢复提交前的 state/current.json、删除对应正文文件、重建 Markdown 视图，并写一条 rollback 审计记录。' +
          '这是重写旧章的唯一安全方式。先用 dryRun 查看将删除哪些文件。',
        parameters: {
          memoryDir: memoryDirParam,
          steps: { type: 'integer', description: '回滚最近几次提交，默认 1，最大 20' },
          dryRun: { type: 'boolean', description: '只预览，不写入' },
          reason: { type: 'string', description: '回滚原因，写入审计日志' },
        },
        output,
        timeoutMs: 60000,
        isConcurrencySafe: () => false,
        async execute(args, exec) {
          assertNotAborted(exec)
          const cwd = sessionCwd(exec)
          const resolved = await resolveMemoryDir({ memoryDir: args.memoryDir, cwd, config: settings })
          return rollbackMemory({
            memoryDir: resolved.memoryDir,
            steps: args.steps,
            dryRun: args.dryRun === true,
            reason: args.reason,
          })
        },
      }),
    ),
  )

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // disposal failures must not break plugin unload
      }
    }
  }
}

/**
 * @param {string} raw
 * @returns {{ action: string, path?: string, title?: string, chapter?: number }}
 */
function parseNovelCommand(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return { action: '' }
  const [actionRaw, ...rest] = text.split(/\s+/)
  const action = actionRaw.toLocaleLowerCase()
  const tail = rest.join(' ').trim()
  if (action === 'init' || action === 'use') {
    const quoted = tail.match(/^"([^"]+)"\s*(.*)$/) || tail.match(/^'([^']+)'\s*(.*)$/)
    if (quoted) return { action, path: quoted[1], title: quoted[2] || undefined }
    const [first, ...remaining] = tail.split(/\s+/)
    return { action, path: first, title: remaining.join(' ') || undefined }
  }
  if (action === 'context') {
    const chapter = Number(tail)
    return { action, chapter: Number.isInteger(chapter) && chapter > 0 ? chapter : undefined }
  }
  return { action }
}

/**
 * @returns {string}
 */
function novelHelp() {
  return [
    '/novel status            查看记忆库状态（默认）',
    '/novel context [章]      预览第 N 章（或下一章）的写作上下文',
    '/novel init <目录> [标题] 创建并绑定记忆库',
    '/novel use <目录>        绑定已有记忆库',
    '/novel help              显示本帮助',
    '',
    '工具：novel_init / novel_use / novel_context / novel_commit / novel_status / novel_search / novel_rollback',
  ].join('\n')
}
