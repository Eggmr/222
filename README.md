# dsh-novel-memory

给 **DeepSeek Harness (dsh)** 用的长篇小说记忆库插件。

它把“写小说”变成可重复的一轮：

```text
读取记忆库 → 按人物/世界观/世界线写正文 → 提交正文和变化 → 自动重建记忆库
```

这样 AI 不会写着写着忘记人物性格、关系、能力上限、时间线，也不会把已经发生的事写崩。  
插件不依赖任何第三方运行时，纯 ESM，Node.js ≥ 20。

---

## 1. 它解决什么问题

普通 AI 写长篇常见的问题：

- 第 30 章忘记第 3 章人物说过什么、性格是什么；
- 人物关系前后矛盾，上一章刚决裂，下一章突然亲密；
- 世界观规则越写越乱，力量体系没有上限；
- 伏笔埋了忘记收，或者收得突兀；
- 时间线错乱，人物同时出现在两个地方；
- 每次续写都要重新粘贴一大堆设定。

`dsh-novel-memory` 的做法：

- 你选定一个**普通文件夹**作为记忆库；
- 插件自动建立 `characters/`、`world/`、`plot/arcs/`、`chapters/`、`state/current.json`；
- 写正文前，`novel_context` 把“当前人物状态 + 关系 + 世界观 + 世界线 + 未回收线索 + 上一章正文”组装成上下文；
- 写完正文，`novel_commit` 把正文中**真实发生的变化**写回数据库，并重建所有子文件；
- 每次提交都有哈希链审计和可回滚快照。

---

## 2. 安装

### 方式 A：作为 npm 包安装到 profile（推荐）

先确保有 pnpm：

```bash
npm install -g pnpm
```

然后：

```bash
dsh plugin --profile web add D:\xinjianwenjianjia7\laji\小说\dsh-novel-memory
```

> 把路径换成你的实际路径。发布到 npm 后也可以直接 `dsh plugin --profile web add dsh-novel-memory`。

如果 profile 没有自动启用这个 bundle，编辑 profile 的 `package.json`，把包名加入 `dsh.profile.bundles`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-web-app",
        "dsh-novel-memory"
      ]
    }
  }
}
```

插件包自身通过 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`：

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### 方式 B：本地源码覆盖层（不需要 pnpm）

在任意位置新建 `my-novel.yml`：

```yaml
- insert:
    - id: novel-memory
      name: 'D:/xinjianwenjianjia7/laji/小说/dsh-novel-memory/index.js'
      config:
        memoryDir: ''
        maxContextChars: 30000
```

启动：

```bash
dsh web --patch ./my-novel.yml
```

> 覆盖层里的 `name` 必须是 **index.js 的绝对路径**。插件里的 `@deepseek-ai/dsh-tools` 会从 dsh 安装目录 / profile 的 `node_modules` 解析；正式 `dsh plugin add` 安装最稳。

### 配置项

`cordis.patch.yml` / 覆盖层支持：

| 字段 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | 空 | 默认记忆库目录；留空则使用工作区 `.dsh-novel.json` 绑定，或由 `novel_init` / `novel_use` 指定 |
| `maxContextChars` | `30000` | `novel_context` 默认返回的最大字符数（中文约等于 token 数） |

---

## 3. 快速开始

安装后，在小说工作区里对 AI 说：

> 帮我建一个小说记忆库，放在 `D:\小说\我的作品-记忆库`，标题《我的作品》，仙侠，文风克制。

AI 会调用：

```json
novel_init({
  "memoryDir": "D:\\小说\\我的作品-记忆库",
  "title": "我的作品",
  "genre": "仙侠",
  "style": "克制、重视人物动机"
})
```

之后每一章：

1. AI 自动调用 `novel_context` 读取上下文；
2. 写正文；
3. AI 自动调用 `novel_commit` 提交正文 + 本章摘要 + `changes`；
4. 插件重建全部人物/世界/世界线文件。

也可以手动用斜杠命令：

```text
/novel init D:\小说\我的作品-记忆库 我的作品
/novel status
/novel context 13
/novel use D:\小说\我的作品-记忆库
/novel help
```

---

## 4. 记忆库文件结构

```text
我的作品-记忆库/
├─ project.json                 # 项目元数据（标题/类型/文风/简介）
├─ README.md                    # 自动生成的记忆库总览
├─ state/
│  └─ current.json              # 唯一事实源：人物、关系、世界、世界线、时间线、线索、章节索引
├─ characters/
│  ├─ _index.md                 # 人物总表
│  ├─ 林砚.md                   # 每个角色一份：性格/外貌/背景/动机/能力/关系/经历
│  └─ 苏婉.md
├─ world/
│  ├─ overview.md               # 世界总览
│  ├─ rules.md                  # 力量体系 / 世界规则
│  ├─ locations.md              # 地点
│  ├─ factions.md               # 势力与组织
│  └─ items.md                  # 重要物品
├─ plot/
│  ├─ timeline.md               # 按章节记录的世界线事件
│  ├─ threads.md                # 未回收线索 / 已回收线索 / 伏笔
│  ├─ chapter-index.md          # 章节索引与摘要
│  └─ arcs/
│     ├─ _index.md              # 篇章总表
│     ├─ 青石镇篇.md            # 每个篇章/世界线一份
│     └─ 北境篇.md
├─ chapters/
│  ├─ 0001-楔子.md              # 正文原稿
│  └─ 0002-....md
├─ history/
│  ├─ commits/                  # 每次提交前的状态快照（可回滚）
│  └─ rolled-back/              # 已回滚的快照
└─ .novel-memory/
   ├─ ledger.jsonl              # 哈希链审计日志
   ├─ journal.json              # 崩溃恢复日志（正常时不存在）
   └─ lock/                     # 写入锁（正常时不存在）
```

### 事实源与视图

- **`state/current.json` 是唯一事实源**。
- `characters/*.md`、`world/*.md`、`plot/*.md` 都是自动生成的**视图**，每次 `novel_commit` 后重建。
- 想让 AI 记住新设定，不要手改视图；通过 `novel_commit` 的 `changes` 写入，或直接改 `state/current.json`（不推荐）。
- 正文原稿 `chapters/*.md` 不会被重建，是版本库里的最终稿。

---

## 5. 工具

### `novel_init`

创建并绑定记忆库。已有 `project.json` 且是本插件的记忆库时不会覆盖，只返回现状。

| 参数 | 必填 | 说明 |
|---|---|---|
| `memoryDir` | 是 | 记忆库根目录（绝对路径或相对工作区） |
| `title` / `genre` / `language` / `style` / `synopsis` | 否 | 项目元数据 |
| `bind` | 否 | 是否写工作区 `.dsh-novel.json`，默认 `true` |

### `novel_use`

绑定一个已有的记忆库目录，之后所有工具可以省略 `memoryDir`。

### `novel_context`

写前读取。返回一个 `<novel-memory readonly="true">` 上下文包，包含：

- 本次任务与硬性写作要求；
- 项目进度、当前世界线；
- 选中人物的性格、动机、能力、关系、最近经历、当前位置/情绪；
- 未回收线索与伏笔；
- 上一章留下的钩子；
- 上一章正文尾部（用于衔接）；
- 最近章节摘要、时间线、世界规则、地点/势力/物品、其他人物索引（预算内）。

| 参数 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | 绑定 | 记忆库目录 |
| `chapter` | 下一章 | 准备写的章节号 |
| `query` | 空 | 本次写作焦点，用于挑选相关人物 |
| `characters` | 自动 | 重点读取的人物姓名数组 |
| `recentChapters` | `3` | 最近几章摘要/时间线 |
| `includeLastChapter` | `true` | 是否带上一章正文 |
| `maxChars` | 配置值 | 上下文最大字符数 |

### `novel_commit`

写完正文后提交。参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `content` | 是 | 本章正文全文（纯正文） |
| `summary` | 是 | 本章摘要：发生了什么、状态如何变化、留下什么钩子 |
| `chapter` | 否 | 章节号；省略 = `lastChapter + 1` |
| `title` | 否 | 本章标题 |
| `changes` | 否 | 人物/世界/世界线/线索/伏笔/时间线变化 |
| `timelinePosition` | 否 | 本章结束时的故事内时间 |
| `nextHooks` | 否 | 下一章钩子 |
| `allowGap` | 否 | 允许跳章，默认 `false` |
| `dryRun` | 否 | 只校验/预览，不写入 |

`changes` 结构：

```json
{
  "characters": [
    {
      "name": "林砚",
      "status": "受伤",
      "location": "北境官道",
      "mood": "愤怒但克制",
      "profile": {
        "personality": "外冷内热，重承诺；被背叛后更难信任他人",
        "motivation": "查清剑谱真相"
      },
      "relationships": [
        { "target": "苏婉", "type": "同门/决裂", "note": "苏婉选择留在师门" }
      ],
      "experiences": ["在藏剑阁发现师父篡改剑谱"]
    }
  ],
  "world": {
    "rules": [{ "title": "剑谱禁制", "text": "完整剑谱需要师徒血誓同时开启" }],
    "locations": [{ "name": "北境官道", "description": "冬季常有流寇" }],
    "factions": [],
    "items": []
  },
  "arcs": [
    { "name": "青石镇篇", "status": "已完结", "summary": "拜师、发现篡改、被逐出师门。" },
    { "name": "北境篇", "status": "进行中", "summary": "前往北境寻找解开禁制的人。" }
  ],
  "threads": [
    { "title": "剑谱篡改真相", "status": "open", "description": "师父为什么篡改？另一半剑谱在哪？" },
    { "title": "苏婉的暗中选择", "status": "open", "description": "她留在师门，但保留了林砚的剑穗。" }
  ],
  "foreshadowing": [
    { "text": "半部剑谱只能练到第三重", "status": "planted" }
  ],
  "timeline": [
    { "time": "腊月初七黄昏", "location": "藏剑阁", "characters": ["林砚", "师父", "苏婉"], "event": "林砚发现剑谱被篡改", "consequences": "被逐出师门" }
  ]
}
```

提交结果：

- 写 `chapters/00NN-标题.md`；
- 更新 `state/current.json`；
- 重建全部人物/世界/世界线 Markdown；
- 追加 `.novel-memory/ledger.jsonl`；
- 写 `history/commits/` 快照；
- 返回内容哈希、状态哈希、审计序号和 warnings。

同一章相同正文重复提交是幂等的；同一章不同正文会报错，防止把时间线写乱。

### `novel_status`

检查进度、人物/篇章/线索数量、章节文件与哈希、Markdown 视图、审计日志哈希链、快照。  
`repair: true` 只重建自动 Markdown 视图，不改正文/JSON。

### `novel_search`

按关键词搜索人物、关系、经历、世界、时间线、线索、伏笔、章节摘要、正文。  
当 `novel_context` 因预算省略了某部分，或需要确认“某人以前做过什么”时使用。

### `novel_rollback`

回滚最近 N 次提交：

```json
novel_rollback({ "steps": 1, "dryRun": true })
novel_rollback({ "steps": 1, "reason": "重写第 12 章" })
```

会恢复提交前的 `state/current.json`、删除对应正文文件、重建视图、写一条 `rollback` 审计记录。  
**这是重写旧章的唯一安全方式**，不要直接覆盖。

---

## 6. 一轮完整示例

```text
用户：接着写第 13 章，写林砚和师父决裂。

AI：
1. novel_context({ chapter: 13, characters: ["林砚", "苏婉"], query: "决裂" })
2. 写正文……
3. novel_commit({
     chapter: 13,
     title: "决裂",
     content: "……正文全文……",
     summary: "林砚发现师父篡改剑谱，被逐出师门；苏婉选择留下，二人关系破裂。",
     changes: { ... },
     nextHooks: ["半部剑谱第三重后反噬", "苏婉的剑穗出现在北境客栈"]
   })
4. 回复用户：已写第 13 章，记忆库已更新。
```

插件在 `novel_commit` 里完成：

```text
校验 → 合并人物/关系/世界/篇章/线索/时间线
→ 生成新 state → 生成全部 Markdown → 写 journal
→ 原子替换文件 → 删 journal → 追加审计日志
```

如果进程在写文件中途崩溃，下一次调用会读取 `journal.json` 自动补完，不会留下半套数据。

---

## 7. 设计细节

- **原子写入**：每次提交先写 `journal.json`，再逐文件原子替换；崩溃后自动恢复。
- **跨进程锁**：`.novel-memory/lock/`，防止两个会话同时写同一记忆库；进程崩溃留下的锁会自动过期。
- **哈希链审计**：每条提交记录 `prevHash` 和自身 `hash`，`novel_status` 会校验链。
- **可回滚快照**：每次提交保存提交前的 `state/current.json` 和 `project.json`。
- **幂等提交**：同一章相同正文不会重复写。
- **章节防覆盖**：不同正文提交同一章会报错，必须回滚后重写。
- **预算控制**：`novel_context` 按优先级组装，必需内容优先，超出预算时截断/省略并提示。
- **无第三方依赖**：只用 Node 内置模块，方便审计和安装。

---

## 8. 开发与测试

```bash
cd D:\xinjianwenjianjia7\laji\小说\dsh-novel-memory
npm test
```

测试覆盖：初始化、提交、人物/关系合并、上下文、搜索、状态检查、回滚、幂等提交、路径绑定。

### 本地覆盖层调试

```bash
dsh web --patch ./my-novel.yml --no-open
```

如果插件里的 `@deepseek-ai/dsh-tools` 解析失败，说明覆盖层插件不在 dsh 仓库/安装目录的模块解析路径里；改用 `dsh plugin --profile web add <绝对路径>` 安装，或在插件目录创建指向 profile `node_modules/@deepseek-ai` 的软链。

---

## 9. 已知边界

- 记忆库是单写入者模型：同一目录不建议同时被多个 dsh 会话高频写；锁会等待/报错，但不会做多主合并。
- `state/current.json` 是事实源；手改 Markdown 视图不会进入事实源。
- 本章“哪些事发生了”由模型在 `novel_commit` 的 `changes` 中提取，插件负责校验、合并、落盘和重建。插件不会自己调用另一个模型去猜剧情。
- 超长章节（例如单章 10 万字）会让 `novel_context` 的上一章部分被截断；可用 `novel_search` 查细节。
- 目前只提供中文模板与中文工具说明；英文界面可后续加。

---

## License

MIT
