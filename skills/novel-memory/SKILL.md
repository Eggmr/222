# 小说记忆库工作流

用于：续写、起草、改写长篇小说；需要人物性格、关系、世界观、世界线、伏笔在几十章后仍然不崩。

记忆库是一个普通文件夹，`state/current.json` 是唯一事实源；人物、世界、世界线 Markdown 是自动生成的视图。**不要直接改 Markdown 视图**，下一次提交会重建它们。

## 何时使用

- 用户要求“接着写”“写下一章”“继续这个故事”“按大纲写一章”。
- 用户要求检查/修正已有章节的逻辑、人物关系、时间线。
- 工作区已经初始化过小说记忆库（有 `.dsh-novel.json`），或用户明确给出记忆库目录。

## 每一轮的硬性流程

### 0. 第一次使用：选定记忆库目录

如果用户还没有指定目录，先问清楚；然后用：

```json
novel_init({
  "memoryDir": "D:\\小说\\我的作品-记忆库",
  "title": "我的作品",
  "genre": "仙侠",
  "style": "克制、重视人物动机，少用感叹号",
  "synopsis": "一句话故事梗概"
})
```

已有记忆库则：

```json
novel_use({ "memoryDir": "D:\\小说\\我的作品-记忆库" })
```

初始化后目录会自动出现：

```
characters/<角色ID>.md
world/overview.md · rules.md · locations.md · factions.md · items.md
plot/timeline.md · threads.md · chapter-index.md · arcs/<篇章ID>.md
chapters/0001-....md
state/current.json
```

### 1. 写前读取：`novel_context`（不可跳过）

```json
novel_context({
  "chapter": 13,
  "query": "本章要写主角与师父决裂",
  "characters": ["林砚", "苏婉"],
  "recentChapters": 3,
  "includeLastChapter": true
})
```

要求：

- 返回的 `<novel-memory>` 内容是**既成事实**，不是建议。
- 人物性格、关系、能力上限、所在地点、知道什么/不知道什么，都以它为准。
- 如果上下文预算省略了某部分，先用 `novel_search` 查，不要凭空补设定。
- 若 `novel_context` 提示“请求的章节已提交”，说明要重写旧章：先 `novel_rollback`，不要直接覆盖。

### 2. 写正文

- 一次只写用户要求的一章（除非用户明确要多章）。
- 不推翻已发生事实；要改变人物关系/能力/立场，必须在正文中写出过程。
- 不让角色知道其不在场时发生的事；不重复上一章已经完成的动作。
- 至少推进或回收一条 `plot/threads.md` 里的未回收线索；若刻意不推进，要在正文或摘要里交代原因。
- 章末留 1–2 个下一章可用的钩子。
- 正文写完后，**必须**进入第 3 步；只回复正文算这一轮没完成。

### 3. 写后回写：`novel_commit`（不可跳过）

把**实际写出的正文**和**正文里真实发生的变化**一起提交：

```json
novel_commit({
  "chapter": 13,
  "title": "决裂",
  "content": "这里是本章正文全文……",
  "summary": "林砚在藏剑阁发现师父篡改剑谱，质问后被逐出师门；苏婉选择留下，二人关系破裂。林砚带走半部剑谱，前往北境。",
  "timelinePosition": "第三年冬，腊月初七",
  "changes": {
    "characters": [
      {
        "name": "林砚",
        "status": "受伤",
        "location": "北境官道",
        "mood": "愤怒但克制",
        "profile": {
          "personality": "外冷内热，重承诺；被背叛后更难信任他人",
          "motivation": "查清剑谱真相，证明师父的罪名"
        },
        "relationships": [
          { "target": "苏婉", "type": "同门/决裂", "note": "苏婉选择留在师门，林砚没有回头" },
          { "target": "师父", "type": "师徒/决裂", "note": "被逐出师门，剑谱成为核心矛盾" }
        ],
        "experiences": [
          "在藏剑阁发现师父篡改剑谱",
          "被师父当众逐出师门，带走半部剑谱"
        ]
      },
      {
        "name": "苏婉",
        "status": "存活",
        "location": "青石镇",
        "relationships": [
          { "target": "林砚", "type": "同门/决裂", "note": "没有跟随林砚离开，但暗中保留了他的剑穗" }
        ]
      }
    ],
    "world": {
      "rules": [
        { "title": "剑谱禁制", "text": "完整剑谱需要师徒血誓同时开启；半部剑谱只能练到第三重。" }
      ],
      "locations": [
        { "name": "北境官道", "description": "通往北境的官道，冬季常有流寇和冻死骨。" }
      ]
    },
    "arcs": [
      { "name": "青石镇篇", "status": "已完结", "summary": "林砚在青石镇拜师、发现剑谱被篡改、被逐出师门。" },
      { "name": "北境篇", "status": "进行中", "summary": "林砚带着半部剑谱前往北境，寻找能解开禁制的人。" }
    ],
    "threads": [
      { "title": "剑谱篡改真相", "status": "open", "description": "师父为什么篡改剑谱？完整剑谱的另一半在哪里？", "relatedCharacters": ["林砚", "师父"] },
      { "title": "苏婉的暗中选择", "status": "open", "description": "苏婉留在师门，但保留了林砚的剑穗，后续可能成为内应。", "relatedCharacters": ["苏婉"] }
    ],
    "foreshadowing": [
      { "text": "林砚带走的是半部剑谱，只能练到第三重", "status": "planted" }
    ],
    "timeline": [
      { "time": "腊月初七黄昏", "location": "藏剑阁", "characters": ["林砚", "师父", "苏婉"], "event": "林砚发现剑谱被篡改，与师父对峙", "consequences": "被逐出师门，带半部剑谱离开" },
      { "time": "腊月初七夜", "location": "北境官道", "characters": ["林砚"], "event": "林砚冒雪北上", "consequences": "进入北境篇" }
    ]
  },
  "nextHooks": [
    "半部剑谱在第三重后出现反噬",
    "苏婉留下的剑穗出现在北境客栈"
  ]
})
```

提交后插件会：

- 写入 `chapters/0013-决裂.md`；
- 更新 `state/current.json`（人物、关系、世界、篇章、线索、伏笔、时间线、章节索引）；
- 重建 `characters/`、`world/`、`plot/` 下所有自动视图；
- 追加 `.novel-memory/ledger.jsonl` 哈希链；
- 写 `history/commits/` 快照，支持回滚。

## 提交内容的写法

### 人物

- 只写**正文中真实发生的变化**。没有变化的人物不必出现。
- 新人物用 `name` 就会被自动建档；已有角色按姓名/别名/ID 匹配。
- `profile` 里的字段是**整合后的完整描述**，会覆盖旧值；不确定就省略，不要写空话。
- `experiences` 只写本章新增经历，插件会自动标上章号并去重。
- 关系用 `relationships`；对象不存在时默认自动建“未登场”人物占位，避免关系悬空。若对象是势力/组织，传 `targetType: "other"`。

### 世界

- `rules` 写力量体系、禁忌、代价、限制；按 `title` 去重更新。
- `locations` / `factions` / `items` 按 `name` 去重更新。
- 不要在第一章就把所有设定写完；只登记正文实际用到或明确提到的。

### 世界线

- `arcs` 是篇章/世界线。新篇章传 `name`，旧篇章传 `id` 或同名。
- 当前章会自动加入所有 `status: "进行中"` 的篇章。
- 一篇结束时把 `status` 设为 `"已完结"`，插件会把当前章记为 `endChapter`；下一章会自动落到仍进行中的篇章，若没有则新建。

### 线索与伏笔

- `threads`：`status: "open"` 埋下，`status: "closed"` 回收；回收时写 `resolution`。
- `foreshadowing`：`planted` 埋下，`paid-off` 回收，`abandoned` 放弃。
- 每章至少推进/回收一条，或在 summary 中说明为什么暂不处理。

## 章节号与重复提交

- 省略 `chapter` 时自动 = `lastChapter + 1`。
- 章节号必须连续；确需跳章传 `allowGap: true`。
- 同一章、相同正文重复提交是幂等的，不会重复写入。
- 同一章、不同正文会报错；**不要覆盖旧章**。正确做法：
  1. `novel_rollback({ steps: 1, dryRun: true })` 预览；
  2. `novel_rollback({ steps: 1, reason: "重写第 12 章" })`；
  3. 重新写、重新 `novel_commit`。

## 查询与维护

- `novel_search({ query: "剑穗", scope: "all" })`：查人物、关系、经历、世界、时间线、线索、伏笔、摘要、正文。
- `novel_status()`：看进度、人物/篇章/线索数量、章节哈希、审计链、快照。
- `novel_status({ repair: true })`：只重建自动 Markdown 视图，不改正文/JSON 事实。

## 绝对不要

1. 不读 `novel_context` 就直接续写。
2. 写完正文不调用 `novel_commit`。
3. 把“计划/大纲”写进 `changes`，而不是正文实际发生的事。
4. 直接改 `characters/*.md`、`world/*.md`、`plot/*.md` 并期待它成为事实源。
5. 直接覆盖已提交章节；用 `novel_rollback`。
6. 让角色知道其不在场时发生的事，或违反已登记的规则/能力上限。
