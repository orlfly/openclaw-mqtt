/**
 * conversation-planner.mjs — 对话引导式角色训练规划器 (v2)
 *
 * 2026-06-11 重大改造：
 *   - 从"下发式"改为"对话引导式"——T1-T3 只发问题，不发文件原文
 *   - T3 拆 3 小轮（T3A 步骤 / T3B 工具 / T3C 例子），避免单任务过载死锁
 *   - T4 写文件拆 3 子步（IDENTITY / SOUL / AGENTS），每步间强制 ping
 *   - T5 拆 3 子步（A 自报 / B 硬指标对照 / C 教头 diff + Agent 漏点复述）
 *   - 默认超时 60s → 300s
 *
 * 设计原则：
 *   - 教头不替 Agent 写文件，发的是问题，Agent 自己用 write 工具落盘
 *   - 教头设标尺但不替 Agent 做决策
 *   - 死锁防护：单轮 ≤ 2KB 输出软约束，> 4KB 不再嵌单条 MQTT
 *   - 验证（V）三层：自报 → 硬指标 → 文件 diff
 *
 * 调用流程：
 *   const planner = new ConversationPlanner({...});
 *   const result = await planner.run(async (text) => {
 *     return await sendAndAwait(text);
 *   });
 */

import { classifyFeedback } from "./feedback-analyzer.mjs";

const STATES = {
  // ── 阶段 1: 问身份 (T1) ──
  T1_ASK:        "T1_ASK",         // 问 Agent：你是谁
  T1_ACK:        "T1_ACK",         // 等待 Agent 复述

  // ── 阶段 2: 问灵魂 (T2) ──
  T2_ASK:        "T2_ASK",         // 问 Agent：边界 + 沉默 + 风格
  T2_ACK:        "T2_ACK",         // 等待 Agent 复述

  // ── 阶段 3: 问工作流 (T3 拆 3 小轮) ──
  T3A_ASK:       "T3A_ASK",        // 问：分几步？每步干什么？
  T3A_ACK:       "T3A_ACK",        // 等待
  T3B_ASK:       "T3B_ASK",        // 问：用什么工具/技能？
  T3B_ACK:       "T3B_ACK",        // 等待
  T3C_ASK:       "T3C_ASK",        // 问：举 1-2 个具体场景例子
  T3C_ACK:       "T3C_ACK",        // 等待

  // ── 阶段 4: 落盘 (T4 拆 3 子步 + 3 ping) ──
  T4A_WRITE:     "T4A_WRITE",      // 写 IDENTITY.md
  T4A_PING:      "T4A_PING",       // 探测 Agent 还活着
  T4B_WRITE:     "T4B_WRITE",      // 写 SOUL.md
  T4B_PING:      "T4B_PING",       // 探测
  T4C_WRITE:     "T4C_WRITE",      // 写 AGENTS.md
  T4C_PING:      "T4C_PING",       // 探测

  // ── 阶段 5: 三层验证 (T5 A+B+C+D) ──
  T5A_SELF_REPORT: "T5A_SELF_REPORT",  // Agent 自报身份
  T5B_HARD_CHECK:  "T5B_HARD_CHECK",   // 教头发硬指标清单，Agent 逐条标记
  T5C_DIFF:        "T5C_DIFF",         // 教头 diff 文件 + Agent 复述漏点
  T5D_REINFORCE:   "T5D_REINFORCE",    // 补强轮：T5B 漏点 >= 1 时让 Agent 补充
  T6_BOOTSTRAP_CLEAR: "T6_BOOTSTRAP_CLEAR",  // 2026-06-11 增: 让 Agent 处理 BOOTSTRAP.md
  // ── 阶段 7: 技能推荐 + 现状对照 (2026-06-11 增) ──
  T7A_RECOMMEND:    "T7A_RECOMMEND",     // 教头发推荐 skill 清单
  T7B_INSTALLED:    "T7B_INSTALLED",     // Agent 报已装清单
  T7C_DECISION:     "T7C_DECISION",      // 教头比对 + Agent 决策要不要装

  COMPLETE:      "COMPLETE",
  ABORT:         "ABORT",
};

// 状态转移：每个状态可去往的下一个状态（按推荐路径）
// RETRY 类（重投）作为兜底不列入正常转移
const TRANSITIONS = {
  T1_ASK:            ["T1_ACK", "ABORT"],
  T1_ACK:            ["T2_ASK", "T1_ASK", "ABORT"],
  T2_ASK:            ["T2_ACK", "ABORT"],
  T2_ACK:            ["T3A_ASK", "T2_ASK", "ABORT"],
  T3A_ASK:           ["T3A_ACK", "ABORT"],
  T3A_ACK:           ["T3B_ASK", "T3A_ASK", "ABORT"],
  T3B_ASK:           ["T3B_ACK", "ABORT"],
  T3B_ACK:           ["T3C_ASK", "T3B_ASK", "ABORT"],
  T3C_ASK:           ["T3C_ACK", "ABORT"],
  T3C_ACK:           ["T4A_WRITE", "T3C_ASK", "ABORT"],
  T4A_WRITE:         ["T4A_PING", "ABORT"],
  T4A_PING:          ["T4B_WRITE", "T4A_WRITE", "ABORT"],
  T4B_WRITE:         ["T4B_PING", "ABORT"],
  T4B_PING:          ["T4C_WRITE", "T4B_WRITE", "ABORT"],
  T4C_WRITE:         ["T4C_PING", "ABORT"],
  T4C_PING:          ["T5A_SELF_REPORT", "T4C_WRITE", "ABORT"],
  T5A_SELF_REPORT:   ["T5B_HARD_CHECK", "T5A_SELF_REPORT", "ABORT"],
  T5B_HARD_CHECK:    ["T5C_DIFF", "T6_BOOTSTRAP_CLEAR", "T5B_HARD_CHECK", "ABORT"],
  // T5B 完后：有漏点 → T5C_DIFF；0 漏点 → T6_BOOTSTRAP_CLEAR (2026-06-11)；重投 T5B
  T5C_DIFF:          ["T5D_REINFORCE", "T6_BOOTSTRAP_CLEAR", "T5C_DIFF", "ABORT"],
  // T5C 完后：有漏点 → T5D_REINFORCE；0 漏点 → T6 收尾；重投 T5C
  T5D_REINFORCE:     ["T5A_SELF_REPORT", "T6_BOOTSTRAP_CLEAR", "T5D_REINFORCE", "ABORT"],
  // T5D 完后：循环退出判定 → T5A 或 T6；重投 → T5D_REINFORCE
  T6_BOOTSTRAP_CLEAR: ["COMPLETE", "T7A_RECOMMEND", "T6_BOOTSTRAP_CLEAR", "ABORT"],
  // 2026-06-11 增：T6 完后可走 T7 推荐技能（默认走）；直接走 COMPLETE 是省略
  T7A_RECOMMEND:     ["T7B_INSTALLED", "T7A_RECOMMEND", "ABORT"],
  T7B_INSTALLED:     ["T7C_DECISION", "T7B_INSTALLED", "ABORT"],
  T7C_DECISION:      ["COMPLETE", "T7C_DECISION", "ABORT"],
  COMPLETE:          [],
  ABORT:             [],
};

export class ConversationPlanner {
  /**
   * @param {Object} opts
   * @param {Object} opts.role - 角色元数据 { roleName, roleEmoji, slug, files, ... }
   * @param {number} [opts.maxTurns=20] - 最大训练回合数（默认 20，留足 5 阶段 18 个状态）
   * @param {Object} [opts.allSections={}] - 角色文件的所有 `##` 段落（用于 T5B 硬指标抽取）
   * @param {Function} [opts.onStateChange] - 状态切换回调
   * @param {Function} [opts.onAgentFeedback] - Agent 回复预览回调
   * @param {string} [opts.agentWorkdir] - Agent 工作目录（用于 T5C diff 提示）
   * @param {Object} [opts.hardChecks] - T5B 硬指标清单（可选：调用方预生成；不传则 planner 自动抽 8 条）
   */
  constructor({
    role,
    maxTurns = 20,
    allSections = {},
    onStateChange,
    onAgentFeedback,
    agentWorkdir,
    hardChecks,
  }) {
    this.role = role;
    this.roleName = role.roleName;
    this.roleEmoji = role.roleEmoji || "🤖";
    this.maxTurns = maxTurns;
    this.allSections = allSections;
    this.onStateChange = onStateChange || (() => {});
    this.onAgentFeedback = onAgentFeedback || (() => {});
    this.agentWorkdir = agentWorkdir;

    // 角色内容（保留字段：用于 T5B 硬指标抽取和 T5C diff 提示）
    this.identity = role.files?.["IDENTITY.md"] || "";
    this.soulContent = role.soul || role.files?.["SOUL.md"] || "";
    this.agentsContent = role.agents || role.files?.["AGENTS.md"] || "";

    // T5B 硬指标清单：教头从原角色文件抽 8-10 条关键硬指标
    this.hardChecks = hardChecks || this._extractHardChecks();

    this.state = STATES.T1_ASK;
    this.history = [];
    this.turn = 0;
    this.t5bResults = null;  // Agent T5B 的逐条标记结果
    this.t5bAttempts = 0;    // T5B 重试计数 (2026-06-11 修)
    // T5 循环机制 (2026-06-11 增): T5A→T5B→T5C→T5D→[循环到 T5A / 或退出]
    this.t5LoopCount = 0;          // T5 循环次数
    this.t5LoopHistory = [];       // 每轮漏点数记录 [{iteration, missed, bResults}]
    this.maxT5Loops = 3;           // T5 最大循环次数 (资源保护)
    this.t7bInstalled = "";        // T7B 解析出的 Agent 已装 skill 列表 (2026-06-11 增)
  }

  async run(sendFn) {
    this.log(`🎯 训练目标: ${this.roleName} ${this.roleEmoji}`);
    this.log(`📊 回合预算: 最多 ${this.maxTurns} 轮`);
    this.log(`📋 训练模式: 对话引导式 (v2)`);
    this.log(`🔍 T5B 硬指标: ${this.hardChecks.length} 条`);
    this.log("");

    while (this.state !== STATES.COMPLETE && this.state !== STATES.ABORT) {
      try {
        await this.step(sendFn);
      } catch (err) {
        this.log(`❌ 异常: ${err.message}`);
        this.transition(STATES.ABORT, { reason: `exception: ${err.message}` });
      }
    }

    return {
      success: this.state === STATES.COMPLETE,
      state: this.state,
      turns: this.turn,
      history: this.history,
      finalReason: this.history[this.history.length - 1]?.reason,
      t5bResults: this.t5bResults,
    };
  }

  async step(sendFn) {
    switch (this.state) {
      // ── 阶段 1: 身份 ──
      case STATES.T1_ASK:     return this.handleAsk(sendFn, "T1", this.planT1Turn.bind(this));
      case STATES.T1_ACK:     return this.handleAck("T1", this._isT1Valid.bind(this), STATES.T2_ASK);

      // ── 阶段 2: 灵魂 ──
      case STATES.T2_ASK:     return this.handleAsk(sendFn, "T2", this.planT2Turn.bind(this));
      case STATES.T2_ACK:     return this.handleAck("T2", this._isT2Valid.bind(this), STATES.T3A_ASK);

      // ── 阶段 3: 工作流（拆 3 小轮）──
      case STATES.T3A_ASK:    return this.handleAsk(sendFn, "T3A", this.planT3ATurn.bind(this));
      case STATES.T3A_ACK:    return this.handleAck("T3A", this._isT3Valid.bind(this), STATES.T3B_ASK);
      case STATES.T3B_ASK:    return this.handleAsk(sendFn, "T3B", this.planT3BTurn.bind(this));
      case STATES.T3B_ACK:    return this.handleAck("T3B", this._isT3Valid.bind(this), STATES.T3C_ASK);
      case STATES.T3C_ASK:    return this.handleAsk(sendFn, "T3C", this.planT3CTurn.bind(this));
      case STATES.T3C_ACK:    return this.handleAck("T3C", this._isT3Valid.bind(this), STATES.T4A_WRITE);

      // ── 阶段 4: 落盘 ──
      case STATES.T4A_WRITE:  return this.handleAsk(sendFn, "T4A", this.planT4AWrite.bind(this));
      case STATES.T4A_PING:   return this.handlePing(sendFn, STATES.T4B_WRITE, "T4A");
      case STATES.T4B_WRITE:  return this.handleAsk(sendFn, "T4B", this.planT4BWrite.bind(this));
      case STATES.T4B_PING:   return this.handlePing(sendFn, STATES.T4C_WRITE, "T4B");
      case STATES.T4C_WRITE:  return this.handleAsk(sendFn, "T4C", this.planT4CWrite.bind(this));
      case STATES.T4C_PING:   return this.handlePing(sendFn, STATES.T5A_SELF_REPORT, "T4C");

      // ── 阶段 5: 三层验证 ──
      case STATES.T5A_SELF_REPORT: return this.handleAsk(sendFn, "T5A", this.planT5ATurn.bind(this));
      case STATES.T5B_HARD_CHECK:  return this.handleT5B(sendFn);
      case STATES.T5C_DIFF:        return this.handleAsk(sendFn, "T5C", this.planT5CTurn.bind(this));
      case STATES.T5D_REINFORCE:   return this.handleAsk(sendFn, "T5D", this.planT5DTurn.bind(this));
      // ── 阶段 6: 基础设定收尾 (2026-06-11 增) ──
      case STATES.T6_BOOTSTRAP_CLEAR: return this.handleAsk(sendFn, "T6", this.planT6Turn.bind(this));
      // ── 阶段 7: 技能推荐 + 现状对照 (2026-06-11 增) ──
      case STATES.T7A_RECOMMEND:    return this.handleAsk(sendFn, "T7A", this.planT7ATurn.bind(this));
      case STATES.T7B_INSTALLED:    return this.handleT7B(sendFn);
      case STATES.T7C_DECISION:     return this.handleAsk(sendFn, "T7C", this.planT7CTurn.bind(this));

      default: throw new Error(`invalid state: ${this.state}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Plan Generation — 每轮发什么（纯问题驱动，不下发文件）
  // ═══════════════════════════════════════════════════════════════════════

  /** T1: 问身份——名字/做什么/服务谁/风格 3 词 */
  planT1Turn() {
    return [
      `我要给你一个新的能力模块。开始之前，请先告诉我 3 件事（用你自己的话，不要照搬）：`,
      ``,
      `1) 你希望被叫做什么名字？`,
      `2) 你做什么工作？服务谁？`,
      `3) 你的工作风格用 3 个形容词概括。`,
      ``,
      `简短回答即可，控制在 200 字内。`,
    ].join("\n");
  }

  /** T2: 问灵魂——边界 3 条 / 沉默场景 / 沟通风格 */
  planT2Turn() {
    return [
      `好。`,
      ``,
      `我接下来要给你加一个能力模块：${this.roleName} ${this.roleEmoji}——${this.roleDesc || "这个角色"}。`,
      ``,
      `在你接受之前，先想清楚 3 件事（用自己的话讲，不要照搬我说的）：`,
      ``,
      `1) 你的边界在哪——什么事绝对不干？`,
      `2) 什么时候你会选择沉默/不回答？`,
      `3) 你的语气/沟通风格是什么（严肃？朋友气？师傅气？）？`,
      ``,
      `控制在 300 字内。`,
    ].join("\n");
  }

  /** T3A: 问工作流步骤 */
  planT3ATurn() {
    return [
      `${this.roleName} 这个角色，你日常怎么干活？分几步？每步干什么？`,
      ``,
      `要求：列步骤，**不要**讲工具和例子。简短，500 字内。`,
    ].join("\n");
  }

  /** T3B: 问工具 */
  planT3BTurn() {
    return [
      `下一步：你日常用哪些工具/技能？按你刚才说的步骤，对应说一下每步用什么工具。`,
      ``,
      `要求：简洁讲，**不要**重复讲步骤本身。500 字内。`,
    ].join("\n");
  }

  /** T3C: 问具体场景例子 */
  planT3CTurn() {
    return [
      `最后：从你刚才的步骤里挑 1-2 步，给我一个**具体场景**例子——你怎么处理？`,
      ``,
      `要求：一两段话讲清楚，**不要**再列工具。500 字内。`,
    ].join("\n");
  }

  /** T4A: 写 IDENTITY.md */
  planT4AWrite() {
    return [
      `${this.roleName}，三轮回答都很好。现在请把对话整理成 3 个文件。`,
      ``,
      `**第一步：先写 IDENTITY.md**——只写"你是谁"：名字、做什么的、服务谁、风格 3 个词。用你自己的话。`,
      ``,
      `写完用 \`cat\` 报文件字节数。`,
    ].join("\n");
  }

  /** T4B: 写 SOUL.md */
  planT4BWrite() {
    return [
      `继续写 **SOUL.md**——写你的灵魂：边界、沉默/不答场景、沟通风格。`,
      ``,
      `用你自己的话，控制在 1-2KB 内。写完 cat 报字节数。`,
    ].join("\n");
  }

  /** T4C: 写 AGENTS.md */
  planT4CWrite() {
    return [
      `最后一个：**AGENTS.md**——写你的工作方式：步骤清单（一句一行）+ 对应工具简表 + 1 个具体场景例子。`,
      ``,
      `**严格控制在 2-4KB 内**，超了我会重发。写完 cat 报字节数。`,
    ].join("\n");
  }

  /** T5A: Agent 自报——身份/工作流/边界 3 句话 */
  planT5ATurn() {
    return [
      `${this.roleName}，最后一轮：自报身份+工作流+边界，3 件事每件一句话。`,
    ].join("\n");
  }

  /** T5C: 教头 diff 文件 + Agent 复述漏点 */
  planT5CTurn() {
    // 2026-06-11 简化：Agent 默认在 cwd 下工作，不指定路径
    return [
      `最后一步：对照原角色定义文档，看你写的 3 个文件漏了什么。`,
      ``,
      `请用 \`read\` 工具读你写的 3 个文件：`,
      `   - \`IDENTITY.md\``,
      `   - \`SOUL.md\``,
      `   - \`AGENTS.md\``,
      ``,
      `然后告诉我：哪些"原角色文件里有的"你没记下来？用列表列出来。`,
      ``,
      `（如果觉得没漏，回"无"。诚实比装懂重要。）`,
    ].join("\n");
  }

  /** T5D: 补强轮——把 T5B 漏点列给 Agent，让它补 */
  planT5DTurn() {
    const missed = this.t5bResults?.results?.filter(r => !r.remembered) || [];
    if (missed.length === 0) {
      // 防御性：T5B 无漏点不该走到 T5D
      return `T5B 漏点为空，跳过补强。`;
    }
    const list = missed.map((m, i) => `${i + 1}. ${m.check}`).join("\n");
    return [
      `补强轮：刚才 T5B 你标记"没记"的有 ${missed.length} 条：`,
      ``,
      list,
      ``,
      `请挑你觉得重要、或可一次性记住的，追加到 \`SOUL.md\` 或 \`AGENTS.md\` 里。`,
      ``,
      `（不强制全部补——你判断哪些适合写进去。补完用 cat 报一下新字节数。）`,
    ].join("\n");
  }

  /** T6: 基础设定收尾 (2026-06-11 增) */
  planT6Turn() {
    const today = new Date().toISOString().slice(0, 10);
    return [
      `最后一步——基础设定收尾：`,
      ``,
      `1. 用 \`ls -la\` 确认 IDENTITY.md / SOUL.md / AGENTS.md 都已存在`,
      `2. \`BOOTSTRAP.md\` 是新装 Agent 的初始化引导文件，现在不需要了。请处理：`,
      `   - 如还在 → \`mv BOOTSTRAP.md BOOTSTRAP.md.done\` (或删除)`,
      `   - 如已不在 → 跳过这一步`,
      `3. 在 \`MEMORY.md\` 顶部加一行：\`# 基础设定完成于 ${today}（role: ${this.roleName}）\``,
      `   - 如 MEMORY.md 不存在 → 用 write 创建`,
      ``,
      `完成后回"基础设定完成"或"已标记"。`,
    ].join("\n");
  }

  /** T7A: 教头发推荐 skill 清单 + 问 Agent 已装什么 */
  planT7ATurn() {
    const skills = this.role.recommendedSkills || [];
    if (skills.length === 0) {
      return `没推荐 skill，跳过 T7。`;
    }
    const list = skills.map((s, i) => `${i + 1}. **${s.name || s.id}** (${s.family || "?"}, ${s.installs || "?"} installs)`).join("\n");
    return [
      `现在进行技能推荐。基于你角色${this.roleName}，匹配到 ${skills.length} 个适合你的 skill：`,
      ``,
      list,
      ``,
      `请用 \`ls ~/.openclaw/skills/\` 看你工作区已装哪些 skill，回我：`,
      `- 已装清单（逗号分隔）`,
      `- 路径不对或其他情况也请说明`,
    ].join("\n");
  }

  /** T7C: 教头比对 推荐 vs 已装 → 列待装 → 要求 Agent 装机 (2026-06-11 改) */
  planT7CTurn() {
    const skills = this.role.recommendedSkills || [];
    const installed = (this.t7bInstalled || "").split(/[,，\s]+/).filter(Boolean);
    const missing = skills.filter(s => !installed.includes(s.name) && !installed.includes(s.id));
    if (missing.length === 0) {
      return `你已装全部推荐 skill，跳过装机。`;
    }
    const list = missing.map((s, i) => {
      const cmd = `skill_workshop install ${s.id}`;
      return `${i + 1}. \`${cmd}\`  (${s.name || s.id}, ${s.family || "?"}, ${s.installs || "?"} installs, path: ${s.path || "?"})`;
    }).join("\n");
    return [
      `推荐 vs 已装对比：你差 ${missing.length} 个 skill，需走 skill_workshop 登记：`,
      ``,
      list,
      ``,
      `请依次运行上面 ${missing.length} 条 \`skill_workshop install\` 命令。`,
      `每装一个等系统回 \`已登记: <id>\`，全部装完后报\`全部已装 + 登记完\`。`,
      ``,
      `如某条 install 报错（如网络/权限），请报出错误，不要跳过。`,
    ].join("\n");
  }

  /** T5B 专用：硬指标对照清单 */
  planT5BTurn() {
    const list = this.hardChecks.map((c, i) => `${i + 1}. ${c}`).join("\n");
    return [
      `现在做一次硬指标对照。下面 ${this.hardChecks.length} 条，**逐条**回 1=记住了 0=没记：`,
      ``,
      list,
      ``,
      `回我格式："x,x,x,..."（${this.hardChecks.length} 个 0/1，中间逗号分隔）`,
      ``,
      `诚实比装懂重要。`,
    ].join("\n");
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  T5B: 硬指标清单生成 + 解析
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * 从原角色文件的 "##" 段落里抽 8-10 条硬指标
   * 策略：找含 "必须"、"绝不在"、"应当"、"不得"、"禁止"、"≥"、数字 + 单位的句子
   */
  _extractHardChecks() {
    const checks = [];
    const seen = new Set();

    // 优先级 1: 显式"必须" / "禁止" / "绝不在" / "不得" 句子
    const mustPatterns = [
      /必须[^。\n]{4,80}/g,
      /绝不在[^。\n]{4,80}/g,
      /绝不能[^。\n]{4,80}/g,
      /不得[^。\n]{4,80}/g,
      /禁止[^。\n]{4,80}/g,
      /不能[^。\n]{4,60}/g,
    ];

    for (const pat of mustPatterns) {
      const matches = this.soulContent.match(pat) || [];
      for (const m of matches) {
        const t = m.trim();
        if (t.length < 5 || t.length > 100) continue;
        // 过滤"标题型"句子（不以实词开头，常以"的/是/了"结尾）
        if (/^[##\s]*[\u4e00-\u9fff]*(身份|职责|使命|任务|核心|主职|关键|主要|重要|总览|概要|原则|什么|如何|怎么|为什么|边界|原则)\s*$/.test(t)) continue;
        if (/必须遵守的/.test(t)) continue;  // "必须遵守的规则"是标题
        if (seen.has(t)) continue;
        seen.add(t);
        checks.push(t);
        if (checks.length >= 6) break;
      }
      if (checks.length >= 6) break;
    }

    // 优先级 2: 数字 + 单位指标（"≤ 30 天"、"≥ 85%"、"< 4.5/5" 等）
    // 单行匹配；不跨行 (用 [^\n] 而非 [^\n。])
    const metricPatterns = [
      /[^\n]*[≤≥<>][^\n]*\d+[^\n]*/g,  // "≤ 30 天" / "≥ 85%"
      /[^\n]*\d+[^\n]*[≤≥<>][^\n]*/g,  // "4.5/5" 后跟 "≥" 之类的 (少见)
      /[^\n]*\d+[%天人个分次条项座分名位元][^\n]*/g,  // "30 天" / "85%"
    ];

    for (const pat of metricPatterns) {
      const matches = this.soulContent.match(pat) || [];
      for (const m of matches) {
        const t = m.trim().replace(/^[•\-*\s]+/, "");
        if (t.length < 5 || t.length > 80) continue;
        if (seen.has(t)) continue;
        seen.add(t);
        checks.push(t);
        if (checks.length >= 10) break;
      }
      if (checks.length >= 10) break;
    }

    // 兜底：如果上面没抽到，从 agentsContent 抽
    if (checks.length < 4) {
      const fallback = this.agentsContent.match(/[一二三四五六七八九十]、[^。\n]{4,60}/g) || [];
      for (const m of fallback) {
        const t = m.trim();
        if (t.length < 5 || seen.has(t)) continue;
        seen.add(t);
        checks.push(t);
        if (checks.length >= 8) break;
      }
    }

    return checks.slice(0, 10);  // 上限 10 条
  }

  /** 解析 Agent T5B 的回复 "1,0,1,1,0,..."  */
  _parseT5BResults(text) {
    if (!text) return null;
    // 找 "x,x,x,..." 模式
    const match = text.match(/([01][,\s，\s]*){2,}/);
    if (!match) return null;

    const tokens = match[0].split(/[,\s，\s]+/).filter(t => /^[01]$/.test(t));
    if (tokens.length < this.hardChecks.length - 3) {
      // 数量严重不符
      return { raw: text, tokens, valid: false };
    }

    const results = this.hardChecks.map((check, i) => ({
      check,
      remembered: tokens[i] === "1",
    }));

    return { raw: text, tokens, valid: true, results };
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  State Handlers
  // ═══════════════════════════════════════════════════════════════════════

  /** 通用：发问题 + 记录 */
  async handleAsk(sendFn, label, planFn) {
    this.turn++;
    this.log(`\n── 第 ${this.turn} 轮 [${label}] ──`);
    const text = planFn();
    const result = await this.dispatch(sendFn, text);
    if (!result.ok) {
      this.recordTurn("trainer", text, "", result.error);
      this.transition(STATES.ABORT, { reason: `${label} failed: ${result.error}` });
      return;
    }
    this.recordTurn("trainer", text, result.reply, null);
    // T4 子步不需要 ACK，直接进 PING；T5 阶段统一走“循环 / 退出”判定；T5 后接 T6 收尾；其他走 _ACK
    let next;
    if (label.startsWith("T4")) next = `${label}_PING`;
    else if (label === "T5A") next = STATES.T5B_HARD_CHECK;
    else if (label === "T5C") {
      // 判定循环：漏点≥1 → T5D_REINFORCE；漏点=0 → 走 T6 收尾
      const missed = this.t5bResults?.results?.filter(r => !r.remembered) || [];
      next = missed.length > 0 ? STATES.T5D_REINFORCE : STATES.T6_BOOTSTRAP_CLEAR;
    } else if (label === "T5D") {
      // T5D 完后：调 T5 循环退出判定；退出后走 T6 收尾
      if (this._shouldExitT5Loop()) {
        next = STATES.T6_BOOTSTRAP_CLEAR;
      } else {
        next = STATES.T5A_SELF_REPORT;
        this.t5LoopCount++;
      }
    } else if (label === "T6") {
      // 2026-06-11 增: T6 完后默认走 T7 推荐技能 (有推荐的话)；无推荐才走 COMPLETE
      const hasSkills = (this.role.recommendedSkills || []).length > 0;
      next = hasSkills ? STATES.T7A_RECOMMEND : STATES.COMPLETE;
    } else if (label === "T7C") next = STATES.COMPLETE;  // T7C 完后走 COMPLETE
    else if (label === "T7A") next = STATES.T7B_INSTALLED;  // T7A 完后走 T7B 解析
    else next = `${label}_ACK`;
    this.transition(next, { reason: `${label} sent; awaiting ${next}` });
  }

  /** 通用：分析 Agent 回复，决定下一步 */
  handleAck(label, validator, nextOk) {
    const lastReply = this.history[this.history.length - 1]?.reply || "";
    this.log(`\n── 第 ${this.turn} 轮 [${label}_ACK] 分析回复 ──`);
    this.onAgentFeedback(lastReply);

    const cls = classifyFeedback(lastReply, this.roleName);
    this.log(`   分类: ${cls.type} (置信度: ${(cls.confidence * 100).toFixed(0)}%)`);

    const valid = validator(lastReply, cls);
    if (valid) {
      this.transition(nextOk, { reason: `${label} ack ok → ${nextOk}` });
    } else if (this.turn < this.maxTurns - 3) {
      // 重投：返回对应的 ASK 状态
      this.transition(this._nextAskState(label), { reason: `${label} ack unclear; re-asking` });
    } else {
      // 接近上限：跳过验证，直接往下走（避免 ABORT 浪费）
      this.log(`   ⚠️ 接近 maxTurns，跳过严格验证，进入下一阶段`);
      this.transition(nextOk, { reason: `${label} ack passed by grace` });
    }
  }

  /** T4 子步间 ping 探测 */
  async handlePing(sendFn, nextOk, label) {
    this.turn++;
    this.log(`\n── 第 ${this.turn} 轮 [${label}_PING] 探测 Agent ──`);
    const text = "ping";
    const result = await this.dispatch(sendFn, text);

    // 通讯失败 → ABORT (这是唯一能发现死锁的信号)
    if (!result.ok) {
      this.recordTurn("trainer", text, "", result.error);
      this.transition(STATES.ABORT, { reason: `${label} ping failed: ${result.error}` });
      return;
    }
    this.recordTurn("trainer", text, result.reply, null);

    // 2026-06-11 fix: 两档判定
    // 1. 明确"活着"信号：1 / ping / pong / 在 / yes / ok
    // 2. 空 reply / 异常长 → 可疑信号
    const reply = (result.reply || "").trim();
    const isAlive = reply.length > 0 && /^(1|ping|pong|在|yes|ok|ok!|👌|✅|y|收到|yo)\b/i.test(reply);

    if (isAlive) {
      this.transition(nextOk, { reason: `${label} ping ok (${reply.slice(0, 12)})` });
    } else if (reply.length === 0) {
      // 空回复 → 高度疑似死锁/丢失，不应继续
      this.log(`   ⚠️ ping 空回复，高度疑似死锁`);
      this.transition(STATES.ABORT, { reason: `${label} ping empty reply` });
    } else {
      // 模糊回复（如 Agent 自顾自说话）：记录警告，但继续
      this.log(`   ⚠️ ping 模糊回复: ${reply.slice(0, 40)}（视为活着但有风险）`);
      this.transition(nextOk, { reason: `${label} ping fuzzy: ${reply.slice(0, 20)}` });
    }
  }

  /** T5B: 发硬指标 + 解析 Agent 标记 */
  async handleT5B(sendFn) {
    this.turn++;
    this.log(`\n── 第 ${this.turn} 轮 [T5B_HARD_CHECK] 硬指标对照 ──`);

    if (this.hardChecks.length === 0) {
      this.log(`   ⚠️ 没抽到硬指标，跳过 T5B`);
      this.transition(STATES.T5C_DIFF, { reason: "no hard checks; skipping T5B" });
      return;
    }

    const text = this.planT5BTurn();
    const result = await this.dispatch(sendFn, text);
    if (!result.ok) {
      this.recordTurn("trainer", text, "", result.error);
      this.transition(STATES.ABORT, { reason: `T5B failed: ${result.error}` });
      return;
    }
    this.recordTurn("trainer", text, result.reply, null);

    const parsed = this._parseT5BResults(result.reply);
    if (parsed && parsed.valid) {
      this.t5bResults = parsed;
      const remembered = parsed.results.filter(r => r.remembered).length;
      const total = parsed.results.length;
      this.log(`   📊 T5B 标记: ${remembered}/${total} 条记住`);

      // 打印漏点
      const missed = parsed.results.filter(r => !r.remembered).map(r => r.check);
      if (missed.length > 0) {
        this.log(`   ⚠️ 漏点 (${missed.length}):`);
        for (const m of missed) this.log(`     - ${m}`);
      }

      // 2026-06-11 增: 记录循环历史，供 _shouldExitT5Loop 使用
      this.t5LoopHistory.push({
        iteration: this.t5LoopCount + 1,
        missed: missed.length,
        total,
        bResults: parsed.results,
      });

      // 0 漏点 → 走 T6 收尾 (不进 T5C/T5A 循环)
      if (missed.length === 0) {
        this.log(`   ✅ T5B 0 漏点 → 走 T6 收尾`);
        this.transition(STATES.T6_BOOTSTRAP_CLEAR, { reason: `T5B 0 漏点 (第 ${this.t5LoopCount + 1} 轮): 走 T6 收尾` });
        return;
      }

      this.transition(STATES.T5C_DIFF, { reason: `T5B parsed: ${remembered}/${total}` });
    } else {
      // 解析失败 → 再来一次（最多 3 次）
      this.t5bAttempts++;
      if (this.t5bAttempts < 3) {
        this.log(`   ⚠️ T5B 回复无法解析 (第 ${this.t5bAttempts} 次重试，raw: ${(result.reply || "").slice(0, 60)}...)`);
        this.transition(STATES.T5B_HARD_CHECK, { reason: `T5B parse failed; retrying (${this.t5bAttempts}/3)` });
      } else {
        this.log(`   ❌ T5B 多次解析失败（${this.t5bAttempts} 次），放弃`);
        this.transition(STATES.T5C_DIFF, { reason: `T5B gave up after ${this.t5bAttempts} attempts; moving to T5C` });
      }
    }
  }

  /** T7B: 解析 Agent 已装 skill 清单 */
  async handleT7B(sendFn) {
    this.turn++;
    this.log(`\n── 第 ${this.turn} 轮 [T7B_INSTALLED] 解析已装清单 ──`);
    // T7B 是一次交互：教头不发 prompt，直接读上一轮 (T7A) 的 Agent 回复
    // 因为 T7A 末尾要求 Agent 回已装清单
    const lastReply = this.history[this.history.length - 1]?.reply || "";
    this.t7bInstalled = lastReply;
    this.log(`   已装 (raw): ${lastReply.slice(0, 80)}`);
    this.transition(STATES.T7C_DECISION, { reason: "T7B 解析已装清单" });
  }

  // ── T5 循环退出判定 (2026-06-11 增) ──

  /**
   * 决定 T5 循环是否退出
   * 退出条件 (满足任一):
   *   1. 乐观: T5B 漏点 = 0 (Agent 已记住全部)
   *   2. 悲观: 漏点不再减少 (T5D 补了但没减少漏点)
   *   3. 资源: t5LoopCount >= maxT5Loops
   * @returns {boolean} true=退出, false=继续循环
   */
  _shouldExitT5Loop() {
    const current = this.t5LoopHistory[this.t5LoopHistory.length - 1];
    if (!current) return true;  // 没历史不循环

    // 1. 乐观停止: 漏点 = 0
    if (current.missed === 0) {
      this.log(`   ✅ T5 循环退出: 漏点=0 (第 ${this.t5LoopCount + 1} 轮)`);
      return true;
    }

    // 2. 悲观停止: 漏点不再减少 (连续 2 轮不进步)
    if (this.t5LoopHistory.length >= 2) {
      const prev = this.t5LoopHistory[this.t5LoopHistory.length - 2];
      if (current.missed >= prev.missed) {
        this.log(`   ⚠️ T5 循环退出: 漏点未减少 (${prev.missed} → ${current.missed})`);
        return true;
      }
    }

    // 3. 资源保护: max loop
    if (this.t5LoopCount >= this.maxT5Loops) {
      this.log(`   ⚠️ T5 循环退出: 达 maxT5Loops=${this.maxT5Loops}`);
      return true;
    }

    this.log(`   🔄 T5 循环: 漏点 ${current.missed} (第 ${this.t5LoopCount + 1} 轮), 下次重走 T5A`);
    return false;
  }

  // ── Validator: 怎么算"OK" ──

  _isT1Valid(reply, cls) {
    // T1: 自报身份——名字/做什么/风格 3 个要素至少有其一
    return reply.length > 10 && (
      /名字|叫我|我是|做什么|服务|风格|adjective|adj/i.test(reply) ||
      cls.type === "VERIFIED"
    );
  }

  _isT2Valid(reply, cls) {
    // T2: 边界/沉默/风格 3 要素至少有其二
    const hits = [
      /边界|绝不|不做|不帮|不参与|不踩|不[一-龥]|红?线/i.test(reply),
      /沉默|不答|不接|拒绝|不回复/i.test(reply),
      /语气|风格|沟通|师傅|朋友|严肃|利落|直接|简洁/i.test(reply),
    ].filter(Boolean).length;
    return hits >= 2;
  }

  _isT3Valid(reply, cls) {
    // T3A/B/C: 至少要有工作流相关关键词
    // 涵盖：步骤 (T3A) / 工具 (T3B) / 场景例子 (T3C) + 招聘领域词
    if (cls.type === "VERIFIED") return true;
    if (reply.length < 15) return false;
    // 工作流相关
    if (/流程|步骤|阶段|分.*?步|环节|节点/i.test(reply)) return true;
    // 工具/平台相关
    if (/工具|技能|系统|平台|软件|ATS|LinkedIn|脉脉|Boss|智联|拉勾|猎聘|Moka|北森|Greenhouse|Workday|飞书|钉钉|Notion|HackerRank|Coderpad|Excel|Sheet/i.test(reply)) return true;
    // 场景/例子相关
    if (/场景|例子|举例|案例|比方|比如|假设|当时|某.*?公司|某.*?岗位/i.test(reply)) return true;
    // 招聘领域词
    if (/简历|面试|JD|offer|岗位|招聘|背调|HR|候选人|用人部门|hc|HC|薪酬|入职/i.test(reply)) return true;
    return false;
  }

  // ── 状态名辅助 ──

  _nextAckState(label) {
    return `${label}_ACK`;
  }
  _nextAskState(label) {
    return `${label}_ASK`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Communication & State Management
  // ═══════════════════════════════════════════════════════════════════════

  async dispatch(sendFn, content) {
    this.log(`   → 发送 (${Buffer.byteLength(content, "utf8")}B / ${content.length} chars)`);
    const result = await sendFn(content);
    if (result.ok) {
      this.log(`   ← 回复 (${(result.reply || "").length} chars)`);
    } else if (result.error) {
      this.log(`   ⚠️ 失败: ${result.error}`);
    }
    return result;
  }

  transition(next, meta = {}) {
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new Error(`invalid transition: ${this.state} → ${next}`);
    }
    const prev = this.state;
    this.state = next;
    this.log(`🔄 ${prev} → ${next}${meta.reason ? ` (${meta.reason})` : ""}`);
    this.onStateChange(next, prev, meta);
  }

  recordTurn(role, sentPayload, reply, error) {
    this.history.push({
      turn: this.history.length + 1,
      role,
      sentPreview: sentPayload ? sentPayload.slice(0, 200) : null,
      reply: reply || "",
      error: error || null,
      timestamp: new Date().toISOString(),
    });
  }

  log(msg) {
    console.log(`  ${msg}`);
  }
}

export { STATES };
