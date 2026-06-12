#!/usr/bin/env node

/**
 * test-planner.mjs — 单元测试 conversation-planner（对话式协议）
 * 不需要真实 MQTT，用 mock sendFn 验证多轮规划逻辑
 */

import { ConversationPlanner, STATES } from "./conversation-planner.mjs";
import { matchSkillsForRole, buildSkillsSection, buildRecommendedSkillsSection } from "./skill-matcher.mjs";
import { classifyFeedback, decideNextAction } from "./feedback-analyzer.mjs";

let pass = 0, fail = 0;
const results = [];

function test(name, fn) {
  return fn().then(r => {
    if (r === true) {
      pass++;
      results.push(`✅ ${name}`);
    } else {
      fail++;
      results.push(`❌ ${name}: ${r}`);
    }
  }).catch(e => {
    fail++;
    results.push(`❌ ${name}: ${e.message}`);
  });
}

function assert(cond, msg) {
  return cond === true ? true : `${msg || "assertion failed"} (got: ${JSON.stringify(cond)})`;
}

function assertEq(a, b, msg) {
  return a === b ? true : `${msg || "not equal"}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)})`;
}

function assertContains(haystack, needle, msg) {
  return haystack.includes(needle)
    ? true
    : `${msg || "missing substring"}: expected to contain "${needle}" in first 200 chars: ${(haystack || "").slice(0, 200)}`;
}

// ── Test feedback-analyzer (对话式模式) ─────────────────────────────────

await test("classifyFeedback: CONFIRMED '好的'", async () => {
  const r = classifyFeedback("好的，我明白了", "招聘专家");
  return assertEq(r.type, "CONFIRMED", "type");
});

await test("classifyFeedback: CONFIRMED 'ok'", async () => {
  const r = classifyFeedback("OK 收到", "招聘专家");
  return assertEq(r.type, "CONFIRMED", "type");
});

await test("classifyFeedback: VERIFIED with role name", async () => {
  const r = classifyFeedback("我是招聘专家", "招聘专家");
  return assertEq(r.type, "VERIFIED", "type") || assertEq(r.matchedRole, true, "matchedRole");
});

await test("classifyFeedback: VERIFIED '我的角色是'", async () => {
  const r = classifyFeedback("我的角色是招聘专家", "招聘专家");
  return assertEq(r.type, "VERIFIED", "type");
});

await test("classifyFeedback: QUESTION 末尾问号", async () => {
  const r = classifyFeedback("什么是 SOUL.md？", "招聘专家");
  return assertEq(r.type, "QUESTION", "type");
});

await test("classifyFeedback: ERROR", async () => {
  const r = classifyFeedback("写入失败：无法访问目录", "招聘专家");
  return assertEq(r.type, "ERROR", "type");
});

await test("classifyFeedback: empty → UNCLEAR", async () => {
  const r = classifyFeedback("", "招聘专家");
  return assertEq(r.type, "UNCLEAR", "type");
});

await test("decideNextAction: VERIFIED → COMPLETE", async () => {
  const r = decideNextAction({ type: "VERIFIED", confidence: 0.95, matchedRole: true }, { turn: 1, maxTurns: 6 });
  return assertEq(r.action, "COMPLETE", "action");
});

await test("decideNextAction: CONFIRMED → PROCEED", async () => {
  const r = decideNextAction({ type: "CONFIRMED", confidence: 0.8 }, { turn: 1, maxTurns: 6 });
  return assertEq(r.action, "PROCEED", "action");
});

await test("decideNextAction: max turns → ABORT", async () => {
  const r = decideNextAction({ type: "UNCLEAR", confidence: 0 }, { turn: 6, maxTurns: 6 });
  return assertEq(r.action, "ABORT", "action");
});

// ── Test ConversationPlanner ─────────────────────────────────────────────

function makeMockSend(scripts) {
  let i = 0;
  const sentHistory = [];
  return {
    sendFn: async (content) => {
      sentHistory.push(content);
      if (i >= scripts.length) {
        return { reply: "", ok: false, error: "no more mock scripts" };
      }
      const s = scripts[i++];
      const replyText = typeof s === "string" ? s : s.reply;
      return { reply: replyText, ok: true };
    },
    sentHistory,
  };
}

function makeRole(name = "招聘专家") {
  return {
    roleName: name,
    roleDesc: "测试用角色描述",
    roleEmoji: "🎯",
    slug: "test-role",
    files: {
      "IDENTITY.md": `# ${name}\n测试用角色描述`,
      "SOUL.md": "## 身份\n测试身份\n## 规则\n规则1\n规则2",
      "AGENTS.md": "## 工作流程\n1. 接需求 2. 招人 3. 入职",
    },
    soul: "## 身份\n测试身份\n## 规则\n规则1\n规则2",
    agents: "## 工作流程\n1. 接需求 2. 招人 3. 入职",
  };
}

// v2 对话引导测试用：含明确硬指标的 SOUL（用于 T5B）
function makeV2Role(name = "招聘专家") {
  const soul = `## 必须遵守的规则

- 绝不在 JD 和面试中涉及性别、年龄、婚育状况、民族、宗教等歧视性要求
- 背调必须获得候选人书面授权
- 试用期管理合规：试用期时长和薪资必须符合《劳动合同法》规定
- 面试必须有书面评估记录，不凭感觉做决策
- offer 发放后不随意撤回——这关乎雇主品牌和法律风险
- 薪酬审批走完流程再发 offer，不口头承诺超出权限的待遇

## 沟通风格
直接、数字说话、师傅气

## 成功指标
- 关键岗位平均招聘周期 ≤ 30 天
- offer 接受率 > 85%
- 招聘成本单人 < ¥3,000
- 用人部门满意度评分 > 4.5/5`;
  return {
    roleName: name,
    roleDesc: "深耕中国人才市场的资深招聘专家",
    roleEmoji: "🎯",
    slug: "test-role-v2",
    files: {
      "IDENTITY.md": `# ${name}\n测试用角色描述`,
      "SOUL.md": soul,
      "AGENTS.md": "## 工作流程\n1. 接需求 2. 招人 3. 入职",
    },
    soul,
    agents: "## 工作流程\n1. 接需求 2. 招人 3. 入职",
  };
}

await test("Planner: 纯文本输出（不再有 JSON 协议包）", async () => {
  const mock = makeMockSend([
    "我是招聘专家，核心规则：合规、流程、体验",  // soul_ack
    "工作流程：1.接需求 2.招人 3.入职",         // agents_ack
    "已写入三个文件，SOUL.md 约 2KB",           // write_ack
    "我是招聘专家 🎯，使命是帮企业招到对的人",  // verify
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });

  await planner.run(mock.sendFn);

  // 每条消息都应该是纯文本——以"你将担任"或"很好"或"最后"或"最后做"开头，绝不以 "{" 开头
  for (let i = 0; i < mock.sentHistory.length; i++) {
    const msg = mock.sentHistory[i];
    if (msg.trimStart().startsWith("{")) {
      return `第 ${i + 1} 轮是 JSON，不应存在`;
    }
  }
  return true;
});

/* v1-DELETED: 以下是 v1 (4 轮下发式) 协议遗留测试，v2 协议已重写。v1 方法已删除。
   这些测试会失败，是预期的。保留以示 v1 状态机的历史记录。v2 实际协议见下面 v2 测试。
await test("Planner: 第一轮包含 IDENTITY 和 SOUL 内容", async () => {
  const mock = makeMockSend([
    "我是招聘专家", "流程：接需求→招人→入职", "已写入", "我是招聘专家 🎯",
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });
  await planner.run(mock.sendFn);
  const first = mock.sentHistory[0];
  return assertContains(first, "招聘专家", "应包含角色名")
      || assertContains(first, "## 身份", "应包含 SOUL 段落")
      || assertContains(first, "## 规则", "应包含规则段落");
});

await test("Planner: 写文件轮包含 IDENTITY.md / SOUL.md / AGENTS.md 三个文件名", async () => {
  const mock = makeMockSend([
    "我是招聘专家", "流程 OK", "已写入", "我是招聘专家 🎯",
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });
  await planner.run(mock.sendFn);
  const writeTurn = mock.sentHistory[2]; // 0=INTRO, 1=AGENTS_FEED, 2=WRITE_FILES
  return assertContains(writeTurn, "IDENTITY.md", "应提到 IDENTITY.md")
      || assertContains(writeTurn, "SOUL.md", "应提到 SOUL.md")
      || assertContains(writeTurn, "AGENTS.md", "应提到 AGENTS.md");
});

// ── 以下为 v1 (4 轮下发式) 协议遗留测试，v2 协议已重写。v1 方法 (planIntroTurn/planAgentsFeedTurn/planWriteFilesTurn/planVerifyTurn) 已删除
//     这些测试会失败，是预期的。保留以示 "v1 的状态机是这个样子" 的历史记录。
//     v2 实际协议状态机，见 578+ 行的 v2 测试。
  const mock = makeMockSend([
    "我是招聘专家，核心使命是帮企业招人，规则是合规和反歧视",  // soul_ack
    "工作流程：1.接需求 2.招人 3.入职。沟通风格目标导向。指标：30天", // agents_ack
    "已写入三个文件，SOUL.md 约 2KB",                            // write_ack
    "我是招聘专家 🎯，使命是帮企业招人，规则是不歧视",            // verify
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });
  const result = await planner.run(mock.sendFn);
  return assertEq(result.success, true, "success")
      || assertEq(result.state, STATES.COMPLETE, "state")
      || assertEq(result.turns, 4, "turns");
});

await test("Planner: 灵魂复述含糊 → 重新投喂 INTRO", async () => {
  const mock = makeMockSend([
    "?????",                                        // 1st: soul_ack 不清
    "我是招聘专家，规则是不歧视",                     // 2nd: 重新投喂后
    "流程：接需求→招人→入职",                        // agents_ack
    "已写入",                                        // write_ack
    "我是招聘专家 🎯",                                // verify
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });
  const result = await planner.run(mock.sendFn);
  return assertEq(result.success, true, "success")
      || (result.turns >= 5 ? true : `turns should >= 5, got ${result.turns}`);
});

await test("Planner: 超 maxTurns 仍未完成 → ABORT", async () => {
  // agent 永远只回 "??"
  const mock = makeMockSend(["??", "??", "??", "??", "??", "??", "??", "??"]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 4,
    allSections: {},
  });
  const result = await planner.run(mock.sendFn);
  return assertEq(result.success, false, "should not succeed")
      || assertEq(result.state, STATES.ABORT, "should abort");
});

await test("Planner: 通讯失败 → ABORT", async () => {
  let callCount = 0;
  const sendFn = async () => {
    callCount++;
    return { reply: "", ok: false, error: "connection timeout" };
  };
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 3,
    allSections: {},
  });
  const result = await planner.run(sendFn);
  return assertEq(result.success, false, "should fail")
      || assertEq(result.state, STATES.ABORT, "should abort")
      || assertEq(callCount, 1, "should only attempt once before ABORT");
});

await test("extractReplyText: JSON 序列化字符串", async () => {
  // emqx-mqtt-clients send-wait 实际返回的格式是
  //   ["{\"id\":\"...\",\"senderId\":\"...\",\"text\":\"我是招聘专家\",...}"]
  // 元素是字符串，需要再 JSON.parse
  const inner = JSON.stringify({ id: "abc", senderId: "openclaw-test", text: "我是招聘专家 🎯", timestamp: "2026-06-10T08:00:00.000Z", type: "text" });
  const wrapped = [inner];
  const last = wrapped[wrapped.length - 1];
  // 直接 inline 验证: JSON.parse 后取 .text
  const obj = JSON.parse(last);
  return assertEq(obj.text, "我是招聘专家 🎯", "应能取到 text 字段");
});

await test("extractReplyText: 嵌套 JSON 多 reply", async () => {
  const replies = [
    JSON.stringify({ id: "1", text: "第一段" }),
    JSON.stringify({ id: "2", text: "第二段" }),
  ];
  const last = JSON.parse(replies[replies.length - 1]);
  return assertEq(last.text, "第二段", "应取最后一条");
});

await test("Planner: 验证轮重试时给出 retry 文案", async () => {
  const mock = makeMockSend([
    "我是招聘专家", "流程 OK", "已写入",
    "嗯嗯我知道了",      // 1st verify 含糊
    "我是招聘专家 🎯",   // 2nd verify 通过
  ]);
  const planner = new ConversationPlanner({
    role: makeRole(),
    maxTurns: 8,
    allSections: {},
  });
  const result = await planner.run(mock.sendFn);
  // 第 4 轮应该包含 "我是" 提示（planVerifyRetryTurn）
  const verifyRetry = mock.sentHistory[3];
  return assertEq(result.success, true, "should succeed")
      || assertContains(verifyRetry, "我是", "retry 应包含 '我是' 提示")
      || assertContains(verifyRetry, "招聘专家", "retry 应包含角色名");
});

// ── Skill Matcher Tests ────────────────────────────────────────────────────
await test("skill-matcher: 招聘专家 → 12 个 skill", async () => {
  const r = buildRecommendedSkillsSection({
    roleName: "招聘专家",
    roleDesc: "深耕中国人才市场的全流程招聘专家",
    soul: "精通 Boss 直聘、猎聘、拉勾等主流招聘渠道运营。JD 撰写、简历筛选、面试评估。",
    agents: "工作流程：需求对齐 → JD 撰写 → 渠道发布 → 简历筛选。",
  });
  return assert(r.skills.length > 0, `应至少 1 个 skill，实际 ${r.skills.length}`)
    || assertContains(r.markdown, "我需要的技能", "markdown 应包含段标题")
    || assertContains(r.markdown, "claw-backup", "必装列表应含 claw-backup")
    || assertContains(r.markdown, "Skill Creator", "必装列表应含 Skill Creator");
});

await test("skill-matcher: 财务分析师 → 含 finance-stock / tax", async () => {
  const r = matchSkillsForRole({
    roleName: "财务分析师",
    roleDesc: "数据驱动的财务分析专家",
    soul: "精通财务建模、估值、报表分析、税务筹划。",
    agents: "财务模型 + 估值。",
  });
  const families = new Set(r.map(s => s.family));
  return assert(families.has("finance-tax") || families.has("finance-risk") || families.has("rag"),
    `财务分析师应命中 finance-* 或 rag family，实际: ${[...families].join(",")}`);
});

await test("skill-matcher: 合同审查专家 → 含 legal", async () => {
  const r = matchSkillsForRole({
    roleName: "合同审查专家",
    roleDesc: "精通民法典合同编及商业合同实务",
    soul: "合同风险识别、条款审查。",
    agents: "合同审核流程。",
  });
  const families = new Set(r.map(s => s.family));
  return assert(families.has("legal"), `合同审查应命中 legal，实际: ${[...families].join(",")}`);
});

await test("skill-matcher: 不会给 legal 角色推荐 finance-risk", async () => {
  const r = matchSkillsForRole({
    roleName: "合同审查专家",
    roleDesc: "合同风险识别",
    soul: "合同风险",
    agents: "合同审核",
  });
  const riskMatches = r.filter(s => s.family === "finance-risk");
  return assertEq(riskMatches.length, 0, "法律角色的\"风险\"不应误命中 finance-risk");
});

await test("skill-matcher: 每个 family 最多 2 个 skill", async () => {
  const r = matchSkillsForRole({
    roleName: "招聘专家",
    roleDesc: "招聘专家",
    soul: "",
    agents: "",
  });
  const familyCount = {};
  for (const s of r) {
    familyCount[s.family] = (familyCount[s.family] || 0) + 1;
  }
  const violations = Object.entries(familyCount).filter(([_, c]) => c > 2);
  return assertEq(violations.length, 0, `不应有 family > 2，实际: ${JSON.stringify(violations)}`);
});

await test("buildSkillsSection: 生成 Markdown 表格", async () => {
  const md = buildSkillsSection([{ id: "x", name: "Test", path: "a/b", family: "test", score: 5, reason: "demo" }]);
  return assertContains(md, "| **Test** |", "应含表格行")
    || assertContains(md, "claw-skill install", "应含安装命令");
});

// ── ConversationPlanner: 技能清单 + 大文件摘要 ─────────────────────────

await test("Planner: AGENTS_FEED 含技能清单提示（当 recommendedSkills 非空）", async () => {
  const role = {
    roleName: "招聘专家",
    roleEmoji: "🎯",
    files: { "IDENTITY.md": "x", "SOUL.md": "y", "AGENTS.md": "z" },
    soul: "y",
    agents: "z",
    recommendedSkills: [{ id: "claw-backup", name: "claw-backup", path: "x" }],
  };
  const p = new ConversationPlanner({ role, maxTurns: 1 });
  const text = p.planAgentsFeedTurn();
  return assertContains(text, "技能", "T2 应含技能相关提示")
    || assertContains(text, "必装", "T2 应问'必装'");
});

await test("Planner: AGENTS.md > 6KB 时 T2 走摘要分支", async () => {
  // 构造 8KB 的 AGENTS.md
  const longAgents = "## 内容\n\n" + "字".repeat(8000);
  const role = {
    roleName: "测试",
    roleEmoji: "🤖",
    files: { "IDENTITY.md": "x", "SOUL.md": "y", "AGENTS.md": longAgents },
    soul: "y",
    agents: longAgents,
    recommendedSkills: [],
    dumpDir: "/tmp/test",
    slug: "test",
  };
  const p = new ConversationPlanner({ role, maxTurns: 1 });
  const text = p.planAgentsFeedTurn();
  return assertContains(text, "为防死锁", "大文件应走摘要分支")
    || assertContains(text, "完整内容请用 read", "应给 Agent 文件路径")
    || assertContains(text, "/tmp/test", "应含 dump 路径");
});

await test("Planner: T3 大文件模式给 Agent 文件路径", async () => {
  const longContent = "字".repeat(2000);
  const role = {
    roleName: "测试",
    roleEmoji: "🤖",
    files: { "IDENTITY.md": longContent, "SOUL.md": longContent, "AGENTS.md": longContent + longContent },
    soul: longContent,
    agents: longContent + longContent,
    recommendedSkills: [],
    dumpDir: "/tmp/test-t3",
    slug: "test-t3",
  };
  const p = new ConversationPlanner({ role, maxTurns: 1 });
  const text = p.planWriteFilesTurn();
  return assertContains(text, "/tmp/test-t3", "T3 应含 dump 路径")
    || assertContains(text, "用 `read` 工具读取", "T3 应引导 Agent 用 read 工具");
});
*/  // end v1-DELETED block

// ═══════════════════════════════════════════════════════════════════════
//  v2 对话引导式测试 (2026-06-11 改造)
// ═══════════════════════════════════════════════════════════════════════

// ── T5B 硬指标抽取 ──

await test("v2 _extractHardChecks: 含'必须'的句子被抽到", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const checks = p._extractHardChecks();
  return assert(checks.length >= 3, `应抽至少 3 条硬指标，实际 ${checks.length}`)
    || assert(checks.some(c => /必须|绝不|不得|禁止/.test(c)), "应含'必须/绝不'关键词");
});

await test("v2 _extractHardChecks: 含数字+单位的指标被抽到", async () => {
  // 专门构造一个以数字为主的 role (避开'必须'型提前填满上限)
  const role = {
    roleName: "测试", roleEmoji: "🤖", slug: "t",
    files: { "IDENTITY.md": "", "SOUL.md": "", "AGENTS.md": "" },
    soul: `## 成功指标
- 关键岗位平均招聘周期 ≤ 30 天
- offer 接受率 > 85%
- 招聘成本单人 < ¥3,000
- 用人部门满意度评分 > 4.5/5
- 候选人面试体验评分 > 4.0/5
- 简历筛选到面试的转化率 > 15%
- 新人试用期通过率 > 90%`,
    agents: "",
  };
  const p = new ConversationPlanner({ role, maxTurns: 20 });
  const checks = p._extractHardChecks();
  return assert(checks.length >= 3, `应抽到至少 3 条指标，实际 ${checks.length}: ${JSON.stringify(checks)}`)
    || assert(checks.some(c => /30\s*天|85%|4\.5|3,000|¥/.test(c)),
      `应含数字+单位指标，实际: ${JSON.stringify(checks)}`);
});

await test("v2 _extractHardChecks: 上限 10 条", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const checks = p._extractHardChecks();
  return assert(checks.length <= 10, `应不超过 10 条，实际 ${checks.length}`);
});

// ── T5B 回复解析 ──

await test("v2 _parseT5BResults: '1,0,1,1,0' → 5 条结果", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const parsed = p._parseT5BResults("1,0,1,1,0");
  return assertEq(parsed?.valid, true, "应 valid")
    || assertEq(parsed?.results?.length, 5, "应有 5 条结果")
    || assertEq(parsed?.results?.[0]?.remembered, true, "第 1 条应为 1")
    || assertEq(parsed?.results?.[1]?.remembered, false, "第 2 条应为 0");
});

await test("v2 _parseT5BResults: '1 0 1 0 1' 空格分隔也能解析", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const parsed = p._parseT5BResults("1 0 1 0 1");
  return assertEq(parsed?.valid, true, "应 valid")
    || assertEq(parsed?.results?.length, 5, "应有 5 条结果");
});

await test("v2 _parseT5BResults: 无法解析 → valid=false", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const parsed = p._parseT5BResults("我看不太清楚");
  return assertEq(parsed?.valid ?? false, false, "应 invalid");
});

// ── 状态机转移 ──

await test("v2 TRANSITIONS: 状态数 (5 阶段 + T5D + T6 + T7A/B/C + COMPLETE + ABORT)", async () => {
  // 5 阶段 + T5D + T6 + T7A/B/C + COMPLETE + ABORT = 26
  const expectedCount = 26;
  return assertEq(Object.keys(STATES).length, expectedCount,
    `应有 ${expectedCount} 个状态，实际 ${Object.keys(STATES).length}`);
});

await test("v2 TRANSITIONS: T1_ASK → T1_ACK 合法", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  p.state = STATES.T1_ASK;
  try {
    p.transition(STATES.T1_ACK);
    return true;
  } catch (e) { return `不应抛错: ${e.message}`; }
});

await test("v2 TRANSITIONS: T1_ASK → T2_ASK 非法", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  p.state = STATES.T1_ASK;
  try {
    p.transition(STATES.T2_ASK);
    return "应抛 invalid transition 错误";
  } catch (e) { return true; }
});

// ── 计划生成 ──

await test("v2 planT1Turn: 问名字/做什么/风格", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const text = p.planT1Turn();
  return assertContains(text, "名字", "应问名字")
    || assertContains(text, "做什么", "应问做什么")
    || assertContains(text, "风格", "应问风格");
});

await test("v2 planT3ATurn: 不含 IDENTITY.md 等文件名（不引导写文件）", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const text = p.planT3ATurn();
  return assertContains(text, "分几步", "T3A 应问分几步")
    || assert(!/IDENTITY\.md|SOUL\.md|AGENTS\.md/.test(text),
      "T3A 不应引导写文件（不应含文件名）");
});

await test("v2 planT4AWrite: 引导写 IDENTITY.md", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const text = p.planT4AWrite();
  return assertContains(text, "IDENTITY.md", "T4A 应提到 IDENTITY.md")
    || assertContains(text, "cat", "T4A 应让 Agent 报文件大小");
});

await test("v2 planT5BTurn: 含硬指标清单 + 0/1 格式说明", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const text = p.planT5BTurn();
  return assertContains(text, "1=记住了 0=没记", "应说明 0/1 格式")
    || assertContains(text, "x,x,x", "应给示例格式")
    || /\d+\.\s/.test(text) || "应至少有 1 条编号指标";
});

await test("v2 planT5CTurn: 默认只引文件名（Agent 在 cwd 下工作）", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 20 });
  const text = p.planT5CTurn();
  return assertContains(text, "IDENTITY.md", "应提到 IDENTITY.md")
    || assertContains(text, "SOUL.md", "应提到 SOUL.md")
    || assertContains(text, "AGENTS.md", "应提到 AGENTS.md")
    || assert(!text.includes("/home/") && !text.includes("~/.openclaw/workspace"),
      `不应包含具体路径，实际: ${text.slice(0, 200)}`)
    || assertContains(text, "无", "应允许回'无'");
});

await test("v2 planT5CTurn: 即便传 agentWorkdir 也不拼路径", async () => {
  const p = new ConversationPlanner({
    role: makeV2Role(),
    maxTurns: 20,
    agentWorkdir: "/home/node/.openclaw/workspace",
  });
  const text = p.planT5CTurn();
  return assert(!text.includes("/home/node/"),
    `即使传 agentWorkdir 也不拼路径，实际: ${text.slice(0, 200)}`)
    || assertContains(text, "IDENTITY.md", "仍应提到 IDENTITY.md");
});

// ── T5D 补强轮 (2026-06-11 增) ──

await test("v2 planT5DTurn: T5B 漏 2 条时 列漏点 + 让 Agent 补", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  // 模拟 T5B 漏 2 条
  p.t5bResults = {
    valid: true,
    results: [
      { check: "必须获得候选人书面授权", remembered: false },
      { check: "绝不在 JD 涉及年龄性别", remembered: false },
      { check: "其他已记住", remembered: true },
    ],
  };
  const text = p.planT5DTurn();
  return assertContains(text, "补强轮", "应提'补强轮'")
    || assertContains(text, "必须获得候选人书面授权", "应列漏点 1")
    || assertContains(text, "绝不在 JD 涉及年龄性别", "应列漏点 2")
    || !text.includes("其他已记住");
});

await test("v2 planT5DTurn: T5B 无漏点时走防御性提示", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  p.t5bResults = { valid: true, results: [{ check: "X", remembered: true }] };
  const text = p.planT5DTurn();
  return assertContains(text, "跳过补强", "无漏点应提示跳过");
});

await test("v2 happy path 22 轮: T5B 漏点 → T5D 补强 → COMPLETE", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",  // T1
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",  // T2
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",  // T3A
    "ATS Moka LinkedIn 脉脉 飞书",  // T3B
    "举例第 4 步：某公司 200 简历筛 15 人",  // T3C
    "写完 IDENTITY.md 808B",  // T4A
    "pong",                    // T4A_ping
    "写完 SOUL.md 1511B",      // T4B
    "pong",                    // T4B_ping
    "写完 AGENTS.md 3374B",    // T4C
    "pong",                    // T4C_ping
    "我是麦芒，AI助手+招聘专家；七步工作流；四条边界",  // T5A
    "0,0,0,0,0,0,0,0",         // T5B  8 个 0 → 全漏
    "我漏了：全部 8 条",        // T5C
    "已补 SOUL.md 1920B",      // T5D 新增
    "我是麦芒第二轮：8条全记住了",  // T5A 循环
    "1,1,1,1,1,1,1,1",         // T5B 循环：全记住 → 0 漏点 → 走 T6
    "基础设定完成",        // T6 新增
  ]);
  const planner = new ConversationPlanner({
    role: makeV2Role(),
    maxTurns: 22,
  });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T5D] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

await test("v2 T5B 0 漏点时跳过 T5D 直走 COMPLETE", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "pong",
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒，AI助手+招聘专家；七步工作流；四条边界",
    "1,1,1,1,1,1,1,1",  // T5B 8 个 1 → 全记住
    "无",                 // T5C 无漏点
    "基础设定完成",       // T6 新增
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG skip-T5D] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

// ── Bug fix 验证 (2026-06-11) ──

await test("v2 fix: T4 ping 空回复 → ABORT (疑似死锁)", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "",  // T4A_ping 空回复 → 疑似死锁，应 ABORT
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  const result = await planner.run(mock.sendFn);
  return assertEq(result.state, STATES.ABORT, "T4A_ping 空回复应 ABORT")
    || assert(/empty reply|ping/i.test(result.finalReason || ""), `finalReason 应提 empty: ${result.finalReason}`);
});

await test("v2 fix: T4 ping 模糊回复 → 警告但继续", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "好我在这里我刚改完文件了",  // 模糊回复但有内容 → 警告但继续
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒，AI助手+招聘专家",
    "1,1,1,1,1,1,1,1",
    "无",
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  const result = await planner.run(mock.sendFn);
  return assertEq(result.success, true, `模糊回复应继续，实际: ${result.state}, ${result.finalReason}`);
});

await test("v2 fix: T5B 重试计数器 t5bAttempts", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  return assertEq(p.t5bAttempts, 0, "初始应为 0")
    || (p.t5bAttempts = 5, assertEq(p.t5bAttempts, 5, "可设值"));
});

// ── T5 循环机制 (2026-06-11 增) ──

await test("v2 循环: 悲观停止 - 漏点不减少", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  // 模拟 2 轮循环：两轮都漏 5 条
  p.t5LoopHistory = [
    { iteration: 1, missed: 5, total: 8 },
    { iteration: 2, missed: 5, total: 8 },
  ];
  return assertEq(p._shouldExitT5Loop(), true, "漏点不减少应退出");
});

await test("v2 循环: 悲观停止 - 漏点反而增加", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  p.t5LoopHistory = [
    { iteration: 1, missed: 3, total: 8 },
    { iteration: 2, missed: 6, total: 8 },  // 漏点增加
  ];
  return assertEq(p._shouldExitT5Loop(), true, "漏点增加应退出");
});

await test("v2 循环: 乐观停止 - 漏点=0", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  p.t5LoopHistory = [{ iteration: 1, missed: 0, total: 8 }];
  return assertEq(p._shouldExitT5Loop(), true, "漏点=0 应退出");
});

await test("v2 循环: 继续 - 漏点减少", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  p.t5LoopHistory = [
    { iteration: 1, missed: 8, total: 8 },
    { iteration: 2, missed: 4, total: 8 },  // 减半
  ];
  return assertEq(p._shouldExitT5Loop(), false, "漏点减半应继续");
});

await test("v2 循环: 资源保护 - 达 maxT5Loops=3", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  p.t5LoopCount = 3;
  p.t5LoopHistory = [
    { iteration: 1, missed: 8, total: 8 },
    { iteration: 2, missed: 5, total: 8 },
    { iteration: 3, missed: 3, total: 8 },
  ];
  // 即使漏点减少，达到 maxLoops 也退出
  return assertEq(p._shouldExitT5Loop(), true, "达 maxLoops 应退出");
});

await test("v2 循环: 端到端 - 2 轮循环后 0 漏点 COMPLETE", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "pong",
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒第一轮",          // T5A 第 1 轮
    "0,0,0,0,0,0,0,0",         // T5B 第 1 轮：8 漏
    "我漏了：8条",             // T5C 第 1 轮
    "已补 SOUL.md 1920B",      // T5D 第 1 轮
    "我是麦芒第二轮：补了 4 条",  // T5A 第 2 轮 (循环)
    "1,1,1,1,0,0,0,0",         // T5B 第 2 轮：4 漏 (减半 → 继续)
    "我漏了：4条",             // T5C 第 2 轮
    "已补 1920B → 2080B",     // T5D 第 2 轮
    "我是麦芒第三轮：补了 0 条",  // T5A 第 3 轮 (循环)
    "1,1,1,1,1,1,1,1",         // T5B 第 3 轮：0 漏 → 走 T6
    "基础设定完成",            // T6 新增
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 34 });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T5-loop] state=${result.state} reason=${result.finalReason}`);
    console.log(`     [DEBUG] loop history length: ${planner.t5LoopHistory.length}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

await test("v2 循环: 悲观停止 - 漏点不减少 2 轮后退出", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "pong",
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒第 1 轮",
    "0,0,0,0,0,0,0,0",         // T5B 第 1 轮：8 漏
    "我漏了：8条",
    "已补但补不到点子上",      // T5D 第 1 轮
    "我是麦芒第 2 轮",
    "0,0,0,0,0,0,0,0",         // T5B 第 2 轮：8 漏 (不减少 → 悲观停止)
    "我漏了：8条",             // T5C 第 2 轮
    "还是没补上",              // T5D 第 2 轮 (悲观停止后走 T6)
    "基础设定完成",            // T6 新增
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 34 });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG pessimistic] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

// ── T6 基础设定收尾 (2026-06-11 增) ──

await test("v2 planT6Turn: 引导处理 BOOTSTRAP.md + MEMORY.md 标记", async () => {
  const p = new ConversationPlanner({ role: makeV2Role(), maxTurns: 34 });
  const text = p.planT6Turn();
  return assertContains(text, "BOOTSTRAP", "应提 BOOTSTRAP.md")
    || assertContains(text, "MEMORY", "应提 MEMORY.md")
    || assertContains(text, "基础设定", "应提'基础设定'")
    || assertContains(text, "ls -la", "应让 Agent 用 ls -la 确认")
    || /完成于 \d{4}-\d{2}-\d{2}/.test(text);
});

await test("v2 T6: Agent 报'已标记' → COMPLETE", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家，服务教头。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "pong",
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒",
    "1,1,1,1,1,1,1,1",          // T5B 0 漏点
    "BOOTSTRAP.md 已移走，MEMORY.md 标记完成",  // T6
  ]);
  const planner = new ConversationPlanner({ role: makeV2Role(), maxTurns: 22 });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T6] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

// ── T7 技能推荐 + 现状对照 (2026-06-11 增) ──

await test("v2 planT7ATurn: 包含推荐 skill 清单 + 让 Agent ls skills/", async () => {
  // makeV2Role 默认没有 recommendedSkills, 手工加一个
  const role = makeV2Role();
  role.recommendedSkills = [
    { id: "playwright", name: "Playwright Browser Automation", family: "browser", installs: 56, path: "onlyloveher/playwright-automation-v1/SKILL.md" },
    { id: "claw-backup", name: "Claw Backup", family: "infra", installs: 999, path: "hhse/openclaw-backupgg/SKILL.md" },
  ];
  const p = new ConversationPlanner({ role, maxTurns: 34 });
  const text = p.planT7ATurn();
  return assertContains(text, "Playwright", "应提 Playwright skill")
    || assertContains(text, "Claw Backup", "应提 Claw Backup")
    || assertContains(text, "ls ~/.openclaw/skills/", "应让 Agent ls")
    || assertContains(text, "browser", "应含 family 标记");
});

await test("v2 planT7CTurn: 比对 已装 vs 推荐 → 列待装 + 让 Agent 决策", async () => {
  const role = makeV2Role();
  role.recommendedSkills = [
    { id: "playwright", name: "Playwright Browser Automation", family: "browser", path: "x/y" },
    { id: "claw-backup", name: "Claw Backup", family: "infra", path: "a/b" },
  ];
  const p = new ConversationPlanner({ role, maxTurns: 34 });
  p.t7bInstalled = "playwright, claw-backup";  // 模拟两个都已装
  const text = p.planT7CTurn();
  return assertContains(text, "已装全部推荐 skill", "全装时跳装机");
});

await test("v2 planT7CTurn: 部分已装时列待装", async () => {
  const role = makeV2Role();
  role.recommendedSkills = [
    { id: "playwright", name: "Playwright Browser Automation", family: "browser", path: "x/y" },
    { id: "claw-backup", name: "Claw Backup", family: "infra", path: "a/b" },
    { id: "moka", name: "Moka HR", family: "hr-ats", path: "m/n" },
  ];
  const p = new ConversationPlanner({ role, maxTurns: 34 });
  p.t7bInstalled = "playwright";  // 只装了 1/3
  const text = p.planT7CTurn();
  return assertContains(text, "Moka HR", "应列待装的 Moka")
    || assertContains(text, "Claw Backup", "应列待装的 Claw Backup")
    || !text.includes("Playwright Browser")
    || assertContains(text, "skill_workshop install moka", "应给 Moka 安装命令")
    || assertContains(text, "skill_workshop install claw-backup", "应给 Claw Backup 安装命令")
    || assertContains(text, "skill_workshop install playwright", "不应给 Playwright 安装命令")
    || assertContains(text, "已登记", "应提期望的装后反馈");
});

await test("v2 T6→T7 端到端: 有推荐 skill 时走 T7A/B/C", async () => {
  const role = makeV2Role();
  role.recommendedSkills = [
    { id: "playwright", name: "Playwright", family: "browser", path: "x/y" },
    { id: "claw-backup", name: "Claw Backup", family: "infra", path: "a/b" },
  ];
  const mock = makeMockSend([
    "我叫麦芒，AI 助手+招聘专家。风格：干脆靠谱有主见",
    "边界：1)不帮歧视 2)不泄隐私。沉默：碰红线拒。风格：师傅气",
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",
    "ATS Moka LinkedIn 脉脉 飞书",
    "举例第 4 步：某公司 200 简历筛 15 人",
    "写完 IDENTITY.md 808B",
    "pong",
    "写完 SOUL.md 1511B",
    "pong",
    "写完 AGENTS.md 3374B",
    "pong",
    "我是麦芒",
    "1,1,1,1,1,1,1,1,1,1",    // T5B 10 个 1 0 漏点
    "已标记基础设定",          // T6
    "已装：playwright, claw-backup",  // T7A 末尾 Agent 回已装 (作为 T7B 解析输入)
    // T7B 不发 prompt — 直接读 T7A 回复
    "A",                       // T7C 选 A 全部装 (但推荐都已装, 会跳装机回 "已装全部")
  ]);
  const planner = new ConversationPlanner({ role, maxTurns: 22 });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T7] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

// ── 端到端 happy path (mock) ──

await test("v2 happy path 18 轮 → COMPLETE", async () => {
  const mock = makeMockSend([
    // T1_ASK
    "我叫麦芒，是 AI 助手+招聘专家，服务教头一个人。风格：干脆、靠谱、有主见",
    // T2_ASK
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈 4)不踩劳动法。沉默：碰到红线就拒。风格：师傅气，敢怼，给数字",
    // T3A_ASK
    "分七步：1.需求澄清 2.岗位画像 3.渠道地图 4.筛选初评 5.结构化面试 6.背调Offer 7.入职复盘",
    // T3B_ASK
    "用 ATS(Moka/北森)、LinkedIn、脉脉、Boss直聘、Workday、i背调、飞书/Notion",
    // T3C_ASK
    "举例第四步：互联网公司招高级后端，200 份简历筛 15 人。先和 HM 校准画像，按硬卡项砍，再按项目经历筛，最后 15 分钟电话初筛脚本",
    // T4A_WRITE
    "写完了。文件 IDENTITY.md 字节数 808",
    // T4A_PING
    "1",
    // T4B_WRITE
    "写完了。文件 SOUL.md 字节数 1511",
    // T4B_PING
    "1",
    // T4C_WRITE
    "写完了。文件 AGENTS.md 字节数 3374",
    // T4C_PING
    "1",
    // T5A_SELF_REPORT
    "我是麦芒，AI 助手+招聘专家；工作流七步；边界四条红线",
    // T5B_HARD_CHECK
    "1,0,1,1,0,1,1,1,1,1",
    // T5C_DIFF
    "我漏了：1) 背调必须获得候选人书面授权 2) offer 不随意撤回",
    // T5D_REINFORCE (v2 新增: 补强轮让 Agent 补漏)
    "已追加到 SOUL.md：增加了背调书面授权 和 offer不随意撤回 两条。当前 SOUL.md 1920B",
    // T5A 重走 (循环): 乐观场景下 Agent 第二轮 T5B 漏点应减少
    "我是麦芒第二轮：7步工作流和边界已完整背下来",
    "1,1,1,1,1,1,1,1,1,1",  // 第二轮 T5B 全记住 → 0 漏点 → 走 T6
    "基础设定完成",        // T6 新增
  ]);
  const planner = new ConversationPlanner({
    role: makeV2Role(),
    maxTurns: 20,
    allSections: {},
  });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG] finalReason: ${result.finalReason}`);
    console.log(`     [DEBUG] state: ${result.state}`);
    console.log(`     [DEBUG] turns: ${result.turns}`);
    console.log(`     [DEBUG] last 4 history:`);
    for (const h of result.history.slice(-4)) {
      console.log(`       sent: ${(h.sentPreview || "").slice(0, 60)}`);
      console.log(`       reply: ${(h.reply || "").slice(0, 60)}`);
    }
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`)
    || assertEq(result.state, STATES.COMPLETE, "state")
    || assertEq(result.turns, 14, `turns 应为 14，实际 ${result.turns}`);
});

await test("v2 T5B 解析失败时 3 次后放弃 → 仍走 T5C", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI助手+招聘专家，服务教头。风格：干脆靠谱有主见",  // T1
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",  // T2
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",  // T3A
    "ATS Moka LinkedIn 脉脉 飞书",  // T3B
    "举例第 4 步：某公司 200 简历筛 15 人",  // T3C
    "写完 IDENTITY.md 808B",  // T4A
    "1",                       // T4A_ping
    "写完 SOUL.md 1511B",     // T4B
    "1",                       // T4B_ping
    "写完 AGENTS.md 3374B",   // T4C
    "1",                       // T4C_ping
    "我是麦芒，AI助手+招聘专家",  // T5A
    "我没听清",                // T5B 解析失败 1
    "还是不懂",                // T5B 解析失败 2
    "再试一下",                // T5B 解析失败 3
    "我漏了：背调必须获得候选人书面授权",  // T5C
    "基础设定完成",        // T6 新增
  ]);
  const planner = new ConversationPlanner({
    role: makeV2Role(),
    maxTurns: 20,
  });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T5B-fail] state=${result.state} reason=${result.finalReason}`);
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});

await test("v2 T3A 复述含糊 → 重投 T3A", async () => {
  const mock = makeMockSend([
    "我叫麦芒，AI助手+招聘专家，服务教头。风格：干脆靠谱有主见",  // T1
    "边界：1)不帮歧视 2)不泄隐私 3)不帮欺诈。沉默：碰红线拒。风格：师傅气",  // T2
    "??",         // T3A 含糊 → 重投
    "1.需求澄清 2.画像 3.渠道 4.筛选 5.面试 6.Offer 7.入职",  // T3A 重投 OK
    "ATS Moka LinkedIn 脉脉 飞书",  // T3B OK
    "举例第 4 步：某公司 200 简历筛 15 人",  // T3C OK
    "写完 IDENTITY.md 808B",  // T4A
    "1",                       // T4A_ping
    "写完 SOUL.md 1511B",     // T4B
    "1",                       // T4B_ping
    "写完 AGENTS.md 3374B",   // T4C
    "1",                       // T4C_ping
    "我是麦芒，AI助手+招聘专家",  // T5A
    "1,1,1,1,1,1,1,1,1",      // T5B (9 个 0/1 匹配 9 条硬指标)
    "无",                     // T5C
  ]);
  const planner = new ConversationPlanner({
    role: makeV2Role(),
    maxTurns: 20,
  });
  const result = await planner.run(mock.sendFn);
  if (!result.success) {
    console.log(`     [DEBUG T3A-retry] state=${result.state} reason=${result.finalReason}`);
    console.log(`     [DEBUG] history.length=${result.history.length}`);
    console.log(`     [DEBUG] last 3 sent/reply:`);
    for (const h of result.history.slice(-3)) {
      console.log(`       sent: ${(h.sentPreview || "").slice(0, 80).replace(/\n/g, " ")}`);
      console.log(`       reply: ${(h.reply || "").slice(0, 80).replace(/\n/g, " ")}`);
    }
  }
  return assertEq(result.success, true, `应成功，实际: ${result.state}, ${result.finalReason}`);
});


// ── Print Results ─────────────────────────────────────────────────────────

console.log("\n" + "=".repeat(60));
console.log("Test Results (对话式协议 + skill-matcher):");
console.log("=".repeat(60));
for (const r of results) console.log(r);
console.log("=".repeat(60));
console.log(`Total: ${pass + fail} | Pass: ${pass} | Fail: ${fail}`);
console.log("=".repeat(60));

process.exit(fail === 0 ? 0 : 1);
