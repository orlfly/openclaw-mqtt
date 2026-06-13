---
name: role-train
description: 多轮对话式角色训练。读取角色描述文件后，生成对话规划，逐轮委派 emqx-mqtt-clients 与目标 Agent 进行对话式通讯。**不依赖 Agent 端实现任何协议**——发的是自然语言消息，agent 收到后自行处理（读、复述、写文件）。适合把 agency-agents-zh 类型的人设灌入到普通对话式 OpenClaw Agent。
metadata:
  requires:
    skills:
      - emqx-mqtt-clients
    tools:
      - node
      - mqtt (npm package, used transitively via emqx-mqtt-clients)
  data:
    - skill-shortlist.json (60 个推荐 skill / 24 个能力族，覆盖 agency-agents-zh 215 个角色)
---

# Role Training — 对话式角色训练

读取角色描述文件（Markdown 格式），**规划**多轮对话，**逐轮委派** emqx-mqtt-clients 执行 MQTT 通讯。

> 训练模式：**纯对话式**。role-train 不再发送 JSON 协议包（`type:"role-train"`），
> 而是发自然语言消息。Agent 收到后自己决定怎么处理（用 write 工具写文件、用 cat
> 复述内容、最后自报身份）。这样**普通对话式 Agent 也能被训练**，不要求 Agent 端
> 实现 role-train 协议。

## 架构：**规划 + 委派**

```
role-train (规划对话内容)
   ↓ 生成该轮自然语言文本
emqx-mqtt-clients send-wait (执行)
   ↓ 发送 + 等待回复
MQTT broker
   ↓
目标 Agent
   ↓ 用自然语言回复
emqx-mqtt-clients (解析)
   ↓ 返回 { reply, ok, error }
role-train (分析 + 规划下一轮)
```

**关键设计**：`role-train` **不直接处理 MQTT**，每轮的发送都委派给 `emqx-mqtt-clients` 的 `send-wait` 子进程。

## 对话流程（5 阶段 18 状态·对话引导式 v2 2026-06-11 改造）

> **v2 设计变化**（vs v1 下发式）：**不**下发任何文件原文，**只**问问题。Agent 收到后自己组织语言、用 write 工具落盘。教头只设标尺，不替 Agent 做决策。
>
> **必读**：`memory/students/openclaw-test.md` 2026-06-11 案例（v1 T3 一次塞多问题→死锁；v2 拆 3 小轮+300s 超时→全程零死锁）。

### 阶段 1: 问身份 (1 轮)

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T1 | T1_ASK | 3 个问题：名字 / 做什么 / 风格 3 词 | 自报"我叫 XX" + 服务对象 + 风格词 |

### 阶段 2: 问灵魂 (1 轮)

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T2 | T2_ASK | 3 个问题：边界 / 沉默场景 / 沟通风格 | 3+ 条具体边界（不是空话）+ 沉默姿态 + 风格描述 |

### 阶段 3: 问工作流（拆 3 小轮避免 T3 过载死锁）

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T3A | T3A_ASK | "分几步？每步干什么？"（**不**问工具例子） | 3-7 步骤清单 |
| T3B | T3B_ASK | "每步用什么工具/技能？" | 工具/平台名清单 |
| T3C | T3C_ASK | "挑 1-2 步举具体场景例子" | 1-2 个含数字/场景/动作的例子 |

### 阶段 4: 落盘（拆 3 子步 + 3 次 ping 探测防死锁）

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T4A | T4A_WRITE | "写 IDENTITY.md，只写'你是谁'" | "写完 + 字节数" |
| T4A | T4A_PING | "ping" | "1" / "在" / 任意 1 字符 |
| T4B | T4B_WRITE | "写 SOUL.md，1-2KB" | "写完 + 字节数" |
| T4B | T4B_PING | "ping" | 同上 |
| T4C | T4C_WRITE | "写 AGENTS.md，2-4KB" | "写完 + 字节数" |
| T4C | T4C_PING | "ping" | 同上 |

### 阶段 5: 三层验证 (A+B+C) + 循环 + 阶段 6 收尾

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T5A | T5A_SELF_REPORT | "3 句话自报身份+工作流+边界" | 3 句压缩复述 |
| T5B | T5B_HARD_CHECK | 5-10 条**从原文件抽出的硬指标**，让 Agent 逐条回 1/0 | `1,0,1,1,0,...` 格式 |
| T5C | T5C_DIFF | "读 3 个文件，告诉我哪些原文件里有的你没记下" | 漏点列表 / "无" |
| T5D | T5D_REINFORCE | 列 T5B 漏点 + 让 Agent 补 SOUL/AGENTS | 报告补了什么 + 新字节数 |
| T5 循环 | 🔁 | T5D 完后调退出判定；不退出则回到 T5A | 漏点逐渐减少或资源耗尽 |
| T6 | T6_BOOTSTRAP_CLEAR | "处理 BOOTSTRAP.md + 在 MEMORY.md 标记基础设定完成" | "已标记"/"已完成" |

### T5 循环退出判定 (2026-06-11 增)

退出条件 (任一):
1. **乐观**: T5B 漏点 = 0 → 走 T6
2. **悲观**: 漏点不减少 (上一轮 ≥ 本轮) → 走 T6
3. **资源**: `t5LoopCount >= maxT5Loops` (默认 3) → 走 T6

走 T6 收尾后调 `planT6Turn()` 让 Agent:
- 确认 3 文件存在 (`ls -la`)
- 处理 BOOTSTRAP.md (移走/删除)
- 在 MEMORY.md 顶部加 `# 基础设定完成于 YYYY-MM-DD`

### 阶段 6→7: 技能推荐 + 现状对照 (2026-06-11 增)

训练完成后，推荐该角色需要的 skill。**T6 完后如有 recommendedSkills → T7**；否则跳过 T7。

| 轮 | 状态 | 发什么 | 期望 Agent 回复 |
|---|---|---|---|
| T7A | T7A_RECOMMEND | 列出 skill-matcher 匹配的 10-12 个推荐 + 让 Agent `ls ~/.openclaw/skills/` | 已装清单（逗号分隔）|
| T7B | T7B_INSTALLED | (不发 prompt) 直接读 T7A 回复解析已装清单 | - |
| T7C | T7C_DECISION | 比对推荐 vs 已装 → 列待装 + **明确给 `skill_workshop install <id>` 命令** | Agent 报"已登记: <id>，全部已装 + 登记完" |

**教头不代 Agent 决策装不装**。

### 死锁防护 4 重门

1. **T3 拆 3 小轮** — 避免单轮复合任务让 Agent 超负荷（v1 死锁诱因）
2. **T4 子步间强制 ping** — 任何一步写完就探测 Agent 还活着，才走下一步
3. **默认超时 300s**（v1 是 60s）— 给 Agent 足够思考时间
4. **大文件 dump 路径** — 训练器不嵌超过 4KB 的内容到单条 MQTT 消息

### 状态机

```
T1_ASK → T1_ACK → T2_ASK → T2_ACK
  → T3A_ASK → T3A_ACK → T3B_ASK → T3B_ACK → T3C_ASK → T3C_ACK
  → T4A_WRITE → T4A_PING → T4B_WRITE → T4B_PING → T4C_WRITE → T4C_PING
  → T5A_SELF_REPORT → T5B_HARD_CHECK → T5C_DIFF
  → T5D_REINFORCE → (循环退出判定) → T5A_SELF_REPORT / T6_BOOTSTRAP_CLEAR
  → T6_BOOTSTRAP_CLEAR → T7A_RECOMMEND (有推荐) / COMPLETE (无推荐)
  → T7A_RECOMMEND → T7B_INSTALLED → T7C_DECISION → COMPLETE
```

如果某轮 Agent 复述含糊，会在该状态内重试 1~2 次；超过 max-turns 仍未达标则 ABORT。T5B 解析失败连续 3 次后放弃 → 仍走 T5C。

## 状态机

```
INTRO → SOUL_ACK ─┬─→ AGENTS_FEED (灵魂复述 OK)
                  └─→ INTRO (含糊则重投)
                          │
                          ↓
                  AGENTS_ACK ─┬─→ WRITE_FILES
                             └─→ AGENTS_FEED (重投)
                                      │
                                      ↓
                              WRITE_ACK ─┬─→ VERIFY
                                         └─→ WRITE_FILES (重发)
                                                  │
                                                  ↓
                                          VERIFY ─┬─→ COMPLETE
                                                  └─→ VERIFY (重试)
```

每轮执行流程：
1. `plan*Turn()` 生成该轮的**纯文本消息**（不再有 JSON 包装）
2. `emqx-mqtt-clients send-wait` 发送并等待回复
3. `classifyFeedback` 分析 agent 回复（识别"我是XX"/"已收到"/"流程是..."等自然语言）
4. 推进状态机

## 反馈分类（`feedback-analyzer.mjs`）

| 类型 | 触发模式 | 例子 |
|------|---------|------|
| `CONFIRMED` | "好的"、"收到"、"已写入"、"明白" | "好的，我明白了" |
| `VERIFIED` | "我是XX"、"我的角色是XX" | "我是招聘专家 🎯" |
| `QUESTION` | 末尾问号、"怎么"、"什么是" | "什么是 SOUL.md？" |
| `ERROR` | "失败"、"无法"、"不能" | "写入失败：无法访问" |
| `NEED_MORE` | "还需要"、"请补充"、"不足" | "流程不够详细" |
| `UNCLEAR` | 兜底 | "..." |

## 依赖

| 依赖 | 是否必需 | 说明 |
|------|---------|------|
| **`emqx-mqtt-clients` skill** | ✅ 必需 | role-train **不直接连 MQTT**，每轮发送都委派给它 |
| `mqtt` npm 包 | 间接 | emqx-mqtt-clients 内部使用 |
| `.env` 配置 | ✅ 必需 | `EMQX_HOST` / `EMQX_MQTT_PORT` / `EMQX_API_KEY` / `EMQX_API_SECRET` / `EMQX_SENDER_*`（与 emqx-mqtt-clients 共用） |
| **目标 Agent 平台** | ✅ 必需 | role-train 通过 `--platform <id>` 选平台（默认 `openclaw`）；详见下文 |

> ⚠️ **前置条件**：必须先安装并配置 `emqx-mqtt-clients` skill。

## 目标 Agent 平台 (2026-06-12 解耦)

role-train 通过 **platform 抽象** 与具体 Agent 平台解耦，不再硬编码 openclaw 特定路径/CLI。

### 内置平台

| platform id | 适用 | skill 目录 | install 命令 |
|---|---|---|---|
| `openclaw` (默认) | OpenClaw 系 Agent | `~/.openclaw/skills/` 等 | `skill_workshop install {id}` |
| `generic` | 其他系 Agent | `./skills/` 等 | `install-skill {id}` |

### 3 层覆盖优先级

```
CLI --platform  >  role.roleMeta.platform  >  env ROLE_TRAIN_PLATFORM  >  默认 'openclaw'
```

### CLI 用法

```bash
# 默认 (openclaw)
node skills/role-train/scripts/train-role.mjs --role-file ... --agent ...

# 显式 generic 平台
node skills/role-train/scripts/train-role.mjs --platform generic --role-file ... --agent ...
```

### 角色文件元数据覆盖 (细粒度)

在 role 文件的 YAML frontmatter 里加 `platform` 段，可对单角色覆盖默认平台：

```yaml
---
name: MyRole
platform:
  id: openclaw       # 用 builtin
  installCommand: "my-skill install {id}"   # 只覆盖这一个字段
---
```

### 添加新平台

在 `scripts/platform-config.mjs` 的 `BUILTIN_PLATFORMS` 加一条：

```js
myplatform: {
  id: "myplatform",
  skillDirs: ["/path/to/skills"],
  installCommand: "my-install {id}",
  installAckPattern: /^installed:\s*(\S+)/i,
  installAckFormat: "installed: <id>",
  defaultSenderId: "trainer",
  fileLayout: "openclaw-triple",  // 或自定义
},
```

> ⚠️ **文件结构前置条件**：role-train **T4-T6 阶段假设 Agent 使用 OpenClaw 标准的 IDENTITY.md / SOUL.md / AGENTS.md 三文件结构**。这不是 platform 抽象的一部分（属于 role-train 的核心设计），若 Agent 使用别的文件结构（如 LangChain 记忆系统），需重写 T4-T6。

## 安装设置

### 1. 安装 emqx-mqtt-clients

```bash
ls ~/.openclaw/workspace/skills/
#  emqx-mqtt-clients/
#  role-train/
```

### 2. 配置 MQTT 连接

```bash
cd ~/.openclaw/workspace
bash skills/emqx-mqtt-clients/scripts/setup.sh
```

### 3. 验证依赖与连接

```bash
node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs
```

## 使用方式

### 多轮对话式训练

```bash
cd ~/.openclaw/workspace
set -a; source .env 2>/dev/null; set +a

node skills/role-train/scripts/train-role.mjs \
  --role-file /opt/workspace/agency-agents-zh/hr/hr-recruiter.md \
  --agent openclaw-test
```

完整对话日志示例：

```
🎯 训练目标: 招聘专家
📊 回合预算: 最多 6 轮

── 第 1 轮 [INTRO] 投喂身份 + 灵魂，要求复述 ──
   → 发送 (5385B)
   ← 回复 (45 chars)
🔄 INTRO → SOUL_ACK

── 第 1 轮 [SOUL_ACK] 分析灵魂复述 ──
   分类: VERIFIED
🔄 SOUL_ACK → AGENTS_FEED (agent acknowledged role)

...（4 轮后）
🔄 VERIFY → COMPLETE

✅ 训练成功！
📊 总回合: 4 / 6
```

### 参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--role-file` | (必填) | 角色描述 `.md` 文件路径 |
| `--agent` | (必填) | 目标 Agent 的 client ID |
| `--max-turns` | `6` | 最大训练回合数（超限中止） |
| `--timeout` | `60` | 单次 MQTT 通讯超时（秒） |
| `--idle-timeout` | `10` | 静默窗口（秒），传给 emqx-mqtt-clients |
| `--dry-run` | `false` | 仅生成 v2 5 阶段 18 状态纯文本规划，不发起训练 |
| `--no-health-check` | `false` | 跳过训练前的健康探测（默认开启，会发 "ping" 探测 Agent 是否在线 + 会回话；探不过不进入训练） |
| `--list-skills` | `false` | 仅打印本角色推荐的 skill 清单，不发起训练（看个面面） |
| `--dump-files <dir>` | - | 把 IDENTITY/SOUL/AGENTS 三文件 dump 到指定目录（Agent 可 read 该路径读完整内容） |

## 🧰 自动推荐技能清单

从 `skill-shortlist.json` 中 60 个 skill / 24 个能力族（覆盖 215 个 agency-agents-zh 角色）里，根据角色描述关键词 + 部门亲和度，**自动**推荐 10-12 个最相关 skill。生成步骤：

1. **关键词匹配**：在 soul/agents 文本中搜「合同 / 股票 / 浏览器 / RAG / 投资」等业务词
2. **部门亲和**：按「HR / 金融 / 营销 / 研发」等部门 补充基础家族
3. **必须装**：每角色都装 `claw-backup`（备份）和 `Skill Creator`（元能力）
4. **同族压限**：同一能力族最多推荐 2 个，避免 office/rag 吐一串

**集成点**：

- ✅ 推荐清单自动追加到 `AGENTS.md` 末尾的「## 🧰 我需要的技能」段（含安装命令 + 自检脚本）
- ✅ T3B (问工具) 问完后，Agent 在复述工作流时自然提到「我需要哪些 skill」——体现「知道自己要什么」

**查看推荐清单**：

```bash
node skills/role-train/scripts/train-role.mjs \
  --role-file /opt/workspace/agency-agents-zh/hr/hr-recruiter.md \
  --agent openclaw-test --list-skills
```

输出示例（招聘专家）：

```
🧰 推荐技能清单 (12 个):

  [2] Markdown Converter 1.0.0
        path:  zhangyingzhuangk/markdown-converter-1-0-0/SKILL.md
        family: office
        reason: 能力族命中: office
  [2] Qmd Skill Main
        ...
  [必装] claw-backup
        path:  hhse/openclaw-backupgg/SKILL.md
        family: infra
        reason: 工作区备份是所有 agent 长期运行的基础
  [必装] Skill Creator
        path:  ciklopentan/skill-creator-canonical/SKILL.md
        family: meta
        reason: 元能力：可以自己创建/审阅 skill
```

> 60 个 skill 全部装在一个 agent 上通常没必要（占内存 + 增加启动时间）。选 family 评分 > 0 的 5-8 个为黄金组合；`必装` 项几乎每角色都需要。

### Dry-run 模式

```bash
node skills/role-train/scripts/train-role.mjs \
  --role-file ./role.md --agent test --dry-run
```

打印 v2 5 阶段 18 状态要发的纯文本，方便审阅。

## 角色描述文件格式

任意标准 Markdown，含 YAML frontmatter 和 `##` 段落：

```yaml
---
name: 角色名称
description: 一句话描述
emoji: 🧠
color: violet
---

## 你的身份与记忆
## 核心使命
## 关键规则
## 沟通风格
## 工作流程
## 成功指标
```

### 段落分类规则（影响写入哪个文件）

| 分类 | 关键词 | 输出文件 |
|------|--------|---------|
| SOUL | 身份、记忆、个性、性格、关键规则、规则、沟通风格、成功指标 | `SOUL.md` |
| AGENTS | 其他 | `AGENTS.md` |

## 文件结构

```
role-train/
├── SKILL.md                       # 本文件
├── skill-shortlist.json           # 60 个推荐 skill 清单（由教头/2026-06-10 提炼）
└── scripts/
    ├── train-role.mjs             # CLI 入口：解析参数、调度 planner、推存 skill
    ├── conversation-planner.mjs   # 状态机：规划 T1~T6 20 状态纯文本内容（含 v2 对话引导 + T5B 硬指标抽取 + T5 循环 + T6 收尾）
    ├── feedback-analyzer.mjs      # 回复分类：识别“已收到/我是XX/错误/问号”
    ├── mqtt-adapter.mjs           # 通讯适配层：封装 emqx-mqtt-clients 的 send-wait
    ├── skill-matcher.mjs          # 🆕 角色→ skill 匹配器（60 skill × 24 family）
    │                                 提供 matchSkillsForRole() / buildSkillsSection() / buildRecommendedSkillsSection()
    └── test-planner.mjs           # 单元测试（29 个用例，含 skill-matcher）
```

**职责分离**：
- `train-role.mjs` 只负责 CLI 参数解析、调度 planner、打印进度
- `conversation-planner.mjs` 负责“规划什么”——状态机、纯文本内容生成（v2 5 阶段 18 状态）
- `feedback-analyzer.mjs` 负责“读什么”——自然语言回复分类
- `mqtt-adapter.mjs` 负责“怎么发”——唯一与 emqx-mqtt-clients 交互的薄适配层

## 调试与排错

### 训练前健康探测失败

默认会发 "ping" 探测 Agent 是否在线 + 会回话。探不过不进入训练，提示：

```
❌ 训练前健康探测未通过：ping timed out after 20s — agent may be locked/offline
   可能原因：
     1. Agent 离线 / 未订阅 ${agent}/inbound
     2. Agent 陷入死锁（参见 memory/students/openclaw-test.md 案例）
     3. 网络/认证问题
   诊断命令：node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs
   如确认 Agent 仍可用，可用 --no-health-check 跳过探测。
```

诊断方法（判断是离线/死锁/网络）：

```bash
# 1. 看 Agent 是否在 broker 上
node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs

# 2. 看详细指标（connected / recv_msg / mailbox_len）
curl -u $EMQX_API_KEY:$EMQX_API_SECRET \
  http://$EMQX_HOST:$EMQX_API_PORT/api/v5/clients/${agent_id} | jq
```

### Agent 始终不复述角色

- 灵魂复述含糊 → planner 会自动重投 INTRO，最多 2 次
- 仍不达标 → ABORT，可加大 `--max-turns` 给更多机会
- Agent 始终"嗯嗯"/"好的"而不讲出角色名 → 调小 `--max-turns` 提前 ABORT

### 通讯超时

- 检查 `.env` 中 EMQX 连接配置
- 调大 `--timeout` 和 `--idle-timeout`

### 文件没落盘 (v2 排查路径)

v2 把写文件拆为 3 子步 (T4A/B/C) + 3 次中间 ping 探测，哪一步丢的能准确定位。

- **T4A 写完不报字节数** → Agent 可能没收到完整指令，重发 T4A
- **T4A 写完但 T4A_ping 不回** → Agent 死锁前兆；T4B 不发、停训练、记日志
- **T4B/C 写完但 cat 报 `No such file`** → Agent 写了别的路径；让它 `pwd` 报出来
- **写后 cat 报超大 (> 10KB)** → Agent 过度发挥，让它重写到 2-4KB
- **T5C Agent 找不到文件** → 报"我读不到"——路径不对；提醒它用 `pwd` 看 cwd

### Agent 在训练后死锁

参考 `memory/students/openclaw-test.md` 案例：3 个文件（总 ~10KB）一次性写可能让 Agent 卡住。
预防：训练前用 `--no-health-check false`（默认）探测；出题验证时控制任务长度 ≤ 100 字。

## 运行测试

```bash
node skills/role-train/scripts/test-planner.mjs
```

预期：18 个测试用例全部通过。
