# dsh-context-curator

DSH 的上下文压缩后端：**删旧工具垃圾，其余内容逐字保留**。

它是 `@deepseek-ai/dsh-compaction-basic` 的替代品（compaction group 里换一行），完整继承后者的触发时机、保留策略、日志事务和 surface 替换，只覆盖它文档里唯一允许覆盖的那个钩子：

    summarize(input, agent, signal)

原版在这里让模型把整段历史**改写成摘要**；这个插件改成问 Jev（快速分类器，不是 LLM）两个问题——「这次调用还需要吗」「输出还需要逐字保留吗」——只删除有把握的部分。保留下来的用户原话与 assistant 正文**逐字**进入 checkpoint，不改写、不浓缩。

核心算法直接移植 [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)（MIT，commit `e3f262a`），见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## 现在的状态：shadow（只记录，不采用）

默认 `adopt: false`：整条管线照跑，决策、概率、节省量全部写日志，但返回给 DSH 的仍然是它自己的摘要。所以现在打开它，行为与原来**完全一致**，只是多了一份日志。看够了再改 `adopt: true`。

## 安装（三步）

1. 建立依赖解析（插件本身的 import 需要指向已安装的 DSH）：

       node tools/link-deps.mjs

2. 生成 preset（把 shipped 的 `standard` 复制一份，只改 compaction 那一行）：

       node tools/install-preset.mjs

   它写到 `~/.dsh/.agent-presets/context-curator/`，在 DSH 的 preset 列表里显示为「标准模式 + 上下文整理（Jev）」。

3. 重启 DSH，新开会话时选这个 preset，跑一次压缩后敲 `/curator`。

## 配置

写在 preset 文件里那一行的 `config:` 下，例如：

    - id: context-curator
      name: 'C:/.../dsh-context-curator/lib/index.js'
      config:
        adopt: true

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 关掉就是纯粹的透传 |
| `adopt` | `false` | false = shadow；true = 收益够大时使用 Jev 的 checkpoint |
| `keepThreshold` | `0.4` | 调用/结果保留所需的最低概率 |
| `preserveRecentMessages` | `6` | 最近 N 条不动（范围第一条永远不动） |
| `maxStateTokens` | `25000` | 发给 Jev 的 state 估算上限 |
| `maxRequestTokens` | `30000` | state + 一批问题的上限 |
| `truncateHeadChars` | `300` | 被砍的结果保留多少字符的头 |
| `minReductionRatio` | `0.15` | 收益低于这个比例就不采用 |
| `minTokensSaved` | `500` | 绝对节省低于这个数也不采用 |
| `jevTimeoutMs` | `5000` | Jev 超时 |
| `jevModel` | `jev-latest` | 模型别名 |
| `logPath` | 空 | 空 = `~/.dsh/context-curator/curator.jsonl` |
| `logEnabled` | `true` | 关闭则只保留内存计数 |

### 为什么阈值不是上游的 0.5

上游用 0.5，并且它自己的 issue 里对这个数和背后的概率标度都有公开质疑；我们的 Jev 也未必是它标定时用的那个。这个插件每一行日志都记下**原始的两个概率**（`keep_call` / `keep_result`），所以阈值以后可以按证据移动，而不是按猜测。默认偏低是刻意的：低阈值 = 「Jev 不太确定就保留」，保留只会多花 token，删错无法挽回。

## 抄下来的安全规则

- 范围第一条消息永远保留（用户最初的约束通常在这里）
- 最近 `preserveRecentMessages` 条永远保留
- 用户与 assistant 的普通文本从不删除、从不改写
- tool call 与 result 按 `tool_use_id` 成对处理，绝不单独删一半
- 含图像/附件的结果**强制保留**——再跑一次工具未必拿得回同样的字节
- 任何不确定 → 保留

## 什么时候回退到 DSH 原生压缩

任何一个条件成立，这次压缩就交回 `super.summarize()`，也就是 DSH 本来会做的事；agent 不会察觉：

| 日志里的 `fallback` | 触发条件 |
|---|---|
| `shadow_mode` | `adopt: false`，这是默认 |
| `disabled` | `enabled: false` |
| `empty_span` | 这段范围没有可处理的消息 |
| `pairing_risk` | 孤儿 result、重复 result、result 早于 call |
| `no_candidates` | 所有调用都被 pin 或受保护 |
| `no_key` | 找不到 TYPESAFE_API_KEY |
| `jev_timeout` / `jev_error` / `malformed` | Jev 不可用或答得不合法 |
| `low_reduction` | 节省比例低于 `minReductionRatio` |
| `not_smaller` | 绝对节省低于 `minTokensSaved` |
| `cancelled` | 压缩被取消 |
| `internal_error` | 本插件自己有 bug |

崩溃、超时、坏响应一律降级成「没整理」，永远不降级成「会话坏了」。

## 两件与其它插件的关系

- 与 **Completion Supervisor 完全独立**：那个判断「活干完了吗」，这个判断「context 太肥了吗」。只共用 Jev 的 key、端点和日志脱敏；policy 与 state 各管各的，互不读取。
- 与 **tool-result-pruner** 互补不冲突：那个先处理单个超大结果（`thresholdChars: 8192`），本插件处理「跨很多轮的旧结果整体过期」。原版后端会在压缩前先调用 pruner，这一步本插件沿用。

## 已知边界

- **preset 是快照**：`install-preset.mjs` 复制的是 shipped `standard`，DSH 升级不会自动更新这份副本（`dsh-agent-presets` 本身没有「改一行」的 patch 语义）。升级后重跑一次脚本即可刷新。
- **绝对路径**：preset 里用绝对路径引用本插件（bare 包名只能从 harness 的 node_modules 解析）。换目录后要重跑安装脚本。
- **`reasoning` block 不进入整理范围**：既不统计也不保留，它们不是恢复工作所需的历史。
- **cache 可能被重写**：替换较早历史会让 provider 的 prompt cache 从第一个改动 token 起失效。日志和 `/curator` 都会记录最近一次请求的 `cache_read_tokens` / `cache_write_tokens`，用来核对「少传 context 省下的钱」有没有被「cache 重写」抵消。
- **不做的事**：不每轮主动 pruning、不在每个 tool result 上调 Jev、不后台周期整理、不改长期 session 文件（原始事件仍在日志里，回放仍能还原真相）。

## 三阶段验证（顺序不能换）

**这里有一个容易搞错的点**：`adopt: false` 时 Jev 的结果根本不会送给模型，DSH 提交的仍是它自己的摘要。所以 shadow 阶段**测不到**「context 真的变小了」「关键上下文还在」「agent 还能接着干活」——那三项只有采用之后才存在。shadow 阶段能测的只有管线本身。

### 阶段 1：shadow，验证管线

新会话选「标准模式 + 上下文整理（Jev）」，保持 `adopt: false`，用足够长的真实会话触发一次压缩，然后：

    node tools/shadow-check.mjs      # 或敲 /curator

逐项看：插件加载、`summarize()` 被调用、Jev 请求成功、before/after token、reduction ratio、KEEP/DROP_RESULT/DROP_CALL、pin 数、pairing 无风险、cache token 有记录、fallback 只有 `shadow_mode`。脚本会明确把「shadow 测不到的三项」标成 NOT EXERCISED，而不是当作通过。

### 阶段 2：adopt，验证三项成功标准

确认阶段 1 干净后，把 preset 那行改成 `adopt: true`，重启，再跑一次长会话，然后判断：

1. context 明显变小（`/curator` 的 before -> after）；
2. 关键约束、当前错误、最新 tool results 仍在（对照 `decisions`：被删的应该只有过期的工具输出）；
3. compact 之后 agent 还能接着正确干活。

这一阶段顺便才真正exercise 到 `compaction/summary` 事件里的 `provider: typesafe` 与 `usage` 字段——shadow 阶段那些字段来自 DSH 自己，不可能报错。

### 阶段 3：fallback smoke

不改代码，只用配置注入一次失败：把 `jevTimeoutMs` 临时设成 `1`（必然超时），重启后触发一次压缩，确认 `/curator` 里那行的 `fallback` 是 `jev_timeout`、会话照常继续（DSH 自己的摘要接管）。看完把 `jevTimeoutMs` 删掉恢复默认。

三项都成立就进入正常使用观察；任何一项不成立就把 `adopt` 切回 false，日志留着当证据。

## 开发

    npm test                  # 核心行为：适配器、三态决策、回退、渲染
    node tools/demo.mjs       # 离线端到端：一份仿真 span 走完整条管线
    node tools/preflight.mjs  # 预检真实代码路径：真实 cordis Context 下的构造、一次真实 Jev 往返、
                              # shadow / adopt / 超时回退、日志字段与脱敏（日志写到临时目录）
    node tools/shadow-check.mjs  # 首次真实运行后的核对表（读 ~/.dsh/context-curator/curator.jsonl）
    node tools/link-deps.mjs --check
    node tools/install-preset.mjs --check

`/curator [limit]` 与 `jev_compaction_status` 工具共用同一份 report builder，都只读：不写日志、不调 Jev、不改任何决策。
