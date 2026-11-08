/**
 * Keyword search across the canonical state and chapter prose.
 *
 * @module dsh-novel-memory/lib/search
 */

import path from 'node:path'
import {
  clampInt,
  readTextIfExists,
  requireText,
  snippetAround,
} from './util.js'
import { loadMemory } from './store.js'
import { arcFileId, characterFileId } from './render.js'

/**
 * @param {{ memoryDir: string, query: string, scope?: string, limit?: number }} input
 * @returns {Promise<Record<string, any>>}
 */
export async function searchMemory(input) {
  const query = requireText(input.query, 'query（搜索词）')
  const scope = ['all', 'characters', 'world', 'plot', 'chapters'].includes(input.scope)
    ? input.scope
    : 'all'
  const limit = clampInt(input.limit, 10, 1, 50)
  const memory = await loadMemory(input.memoryDir)
  const { state, memoryDir } = memory
  const warnings = []
  const found = []
  const needle = query.toLocaleLowerCase()

  const add = (category, file, title, text) => {
    const source = String(text ?? '')
    if (source === '' || !source.toLocaleLowerCase().includes(needle)) return
    found.push({
      category,
      file,
      title,
      snippet: snippetAround(source.replace(/\s+/g, ' '), query, 70),
    })
  }

  if (scope === 'all' || scope === 'characters') {
    for (const character of Object.values(state.characters)) {
      const file = 'characters/' + characterFileId(character) + '.md'
      add('人物', file, character.name, [
        character.name,
        character.aliases.join(' '),
        character.role,
        character.status,
        character.location,
        character.mood,
        character.profile.personality,
        character.profile.appearance,
        character.profile.background,
        character.profile.motivation,
        character.profile.abilities,
        character.profile.arc,
        character.notes,
      ].join('\n'))
      for (const rel of character.relationships) {
        add('人物关系', file, character.name + ' → ' + rel.target, [rel.target, rel.type, rel.note, rel.attitude].join(' '))
      }
      for (const experience of character.experiences) {
        add('人物经历', file, character.name + ' · 第' + experience.chapter + '章', experience.text)
      }
    }
  }

  if (scope === 'all' || scope === 'world') {
    add('世界', 'world/overview.md', '世界总览', state.world.overview)
    for (const rule of state.world.rules) {
      add('世界规则', 'world/rules.md', rule.title || rule.name || '规则', [rule.title, rule.text, rule.description].join(' '))
    }
    for (const [label, items, file] of [
      ['地点', state.world.locations, 'world/locations.md'],
      ['势力', state.world.factions, 'world/factions.md'],
      ['物品', state.world.items, 'world/items.md'],
    ]) {
      for (const item of items) {
        add(label, file, item.name || item.title || label, [item.name, item.title, item.description].join(' '))
      }
    }
  }

  if (scope === 'all' || scope === 'plot') {
    for (const arc of Object.values(state.arcs)) {
      add('世界线', 'plot/arcs/' + arcFileId(arc) + '.md', arc.name, [arc.name, arc.status, arc.summary].join(' '))
    }
    for (const event of state.timeline) {
      add('时间线', 'plot/timeline.md', '第' + event.chapter + '章', [event.time, event.location, event.characters.join(' '), event.event, event.consequences].join(' '))
    }
    for (const thread of state.threads) {
      add('线索', 'plot/threads.md', thread.title, [thread.title, thread.description, thread.resolution, thread.relatedCharacters.join(' ')].join(' '))
    }
    for (const item of state.foreshadowing) {
      add('伏笔', 'plot/threads.md', item.text, [item.text, item.payoff].join(' '))
    }
    for (const chapter of state.chapters) {
      add('章节摘要', 'plot/chapter-index.md', '第' + chapter.number + '章《' + chapter.title + '》', chapter.summary)
    }
  }

  if (scope === 'all' || scope === 'chapters') {
    for (const chapter of state.chapters) {
      if (!chapter.file) continue
      const text = await readTextIfExists(path.join(memoryDir, chapter.file))
      if (text == null) {
        warnings.push('章节文件缺失：' + chapter.file)
        continue
      }
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].toLocaleLowerCase().includes(needle)) {
          found.push({
            category: '正文',
            file: chapter.file + ':' + (i + 1),
            title: '第' + chapter.number + '章《' + chapter.title + '》',
            snippet: snippetAround(lines[i].trim(), query, 70),
          })
          break
        }
      }
    }
  }

  const results = found.slice(0, limit)
  const lines = [
    `# 搜索：${query}`,
    `范围：${scope} ｜ 命中：${found.length} ｜ 返回：${results.length}`,
    ...warnings.map((warning) => '> ' + warning),
  ]
  if (!results.length) {
    lines.push('', '没有找到匹配内容。可尝试更短的关键词，或把 scope 设为 all。')
  } else {
    for (const result of results) {
      lines.push('', `- **[${result.category}] ${result.title}** \`${result.file}\``, '  ' + result.snippet)
    }
  }
  return {
    query,
    scope,
    total: found.length,
    returned: results.length,
    results,
    warnings,
    text: lines.join('\n'),
  }
}
