#!/usr/bin/env node

/**
 * train-role.mjs — 对话式角色训练 CLI 入口
 *
 * 工作流程：
 *   1. 解析角色描述文件 → 生成 IDENTITY.md / SOUL.md / AGENTS.md
 *   2. 启动对话计划器（conversation-planner.mjs）
 *   3. 对每一轮：
 *      a. planner 根据当前状态生成该轮的纯文本内容
 *      b. 通过 emqx-mqtt-clients 的 send-wait 命令发送（委派 MQTT 通讯）
 *      c. planner 解析 agent 回复，更新状态，生成下一轮内容
 *   4. 满足完成条件或达到 max-turns 后结束
 *
 * 关键设计：
 *   - role-train **不直接处理 MQTT 通讯**——所有 send-wait 都通过
 *     exec 调用 emqx-mqtt-clients 脚本完成
 *   - 协议是"纯对话式"：发的是自然语言消息，agent 收到后自行处理
 *     （写文件 / 复述 / 验证），不再依赖 agent 端实现 role-train 协议
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { ConversationPlanner } from "./conversation-planner.mjs";
import { MqttClient, healthCheck, resolveEmqxScript } from "./mqtt-adapter.mjs";
import { buildRecommendedSkillsSection } from "./skill-matcher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");

const SOUL_KEYWORDS = ["身份", "记忆", "个性", "性格", "关键规则", "规则", "沟通风格", "成功指标", "你必须遵守"];

function log(label, msg) { console.log(`  ${label.padEnd(14)} ${msg}`); }
function die(msg) { console.error(`\n❌ ${msg}`); process.exit(1); }

// ── Role File Parsing ──────────────────────────────────────────────────────

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const fm = {};
  let k = null;
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)/);
    if (kv) { k = kv[1]; fm[k] = kv[2].replace(/^["']|["']$/g, ""); }
    else if (k && line.trim()) { fm[k] += " " + line.trim(); }
  }
  return fm;
}

function getAllSections(content) {
  const sections = {};
  const lines = content.split("\n");
  let h = null, body = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(.+)/);
    if (m) {
      if (h) sections[h] = body.join("\n").trim();
      h = m[1].trim().replace(/[🛡️🔑📌🔒📐🔬🧪⚖️📜🏆🎯🎨🎭🎪🔮💼💡⚡🌀♻️📤📥💬🗣️👥👤📝✏️📄📃📊📈📉📋📌📍📎🔗💰💳📦📱💻🖥️🖨️⌨️🖱️🖲️🕹️🗄️🗃️📁📂📇🔧🔩💉💊🧠🦷🦴🦾🦿🦻👂👃👁️👀👅👄👶👧🧒👦👩🧑👨🧓👴👲👳👸🤴🦸🦹🧙🧛🧜🧝🧞🧟🧌🧚🫀🫁🔨🪛🪚🪜]/g, "").trim();
      body = [];
    } else if (h) { body.push(line); }
  }
  if (h) sections[h] = body.join("\n").trim();
  return sections;
}

function isSoulSection(heading) {
  const h = heading.replace(/^[^\w\u4e00-\u9fff]+/g, "").trim();
  return SOUL_KEYWORDS.some(kw => h.includes(kw));
}

async function buildRoleFiles(roleFilePath, fm, allSections) {
  const roleName = fm.name || basename(roleFilePath, ".md");
  const roleDesc = fm.description || "";
  const roleEmoji = fm.emoji || "🤖";
  const roleColor = fm.color || "gray";

  const soulParts = [];
  const agentsParts = [];
  for (const [heading, body] of Object.entries(allSections)) {
    const sec = `## ${heading}\n\n${body}`;
    if (isSoulSection(heading)) soulParts.push(sec);
    else agentsParts.push(sec);
  }

  const slug = basename(roleFilePath).replace(/\.md$/i, "");

  const identity = `# ${roleName}\n${roleDesc}`;
  const soulContent = soulParts.join("\n\n");

  const preamble = `# AGENTS.md - 工作空间规范\n\n` +
    `这是你的工作空间，**必须严格按照以下规范工作**。\n\n` +
    `## Session 启动流程\n\n` +
    `每次会话开始时，按以下顺序自动执行：\n\n` +
    `1. 读取 \`SOUL.md\` - 加载性格和行为风格\n` +
    `2. 读取 \`IDENTITY.md\` - 了解你的身份描述\n\n` +
    `以上操作无需询问，自动执行。\n\n` +
    `## 记忆管理规范\n\n` +
    `你每次启动都是全新状态，这些文件是你的记忆延续。\n\n` +
    `| 层级 | 文件路径 | 存储内容 |\n` +
    `|------|---------|---------|\n` +
    `| 索引层 | \`MEMORY.md\` | 核心信息和记忆索引，保持精简 |\n`;

  const agentsContent = agentsParts.length > 0
    ? preamble + "\n---\n\n" + agentsParts.join("\n\n")
    : preamble;

  // 🎯 追加「我需要的技能」段：把角色能力映射到 60 个 skill
  //   - 让 agent 知道自己该装哪些 skill
  //   - 教头/管理员可参考这份清单逐个安装
  const skillMatch = buildRecommendedSkillsSection({
    roleName, roleDesc, soulContent, agentsContent,
  });
  const agentsWithSkills = agentsContent + "\n" + skillMatch.markdown;

  // 📁 自动 dump 完整三文件到 /tmp/role-train/<slug>/，供 T2/T3 的 Agent 读
  // 原因：agency-agents-zh 角色描述较长（AGENTS.md 经常 5-12KB），单条 MQTT
  // 消息嵌入全文会超过 4KB 警戒线，有 Agent 死锁风险（openclaw-test 2026-06-10 案例）。
  // 解法：T2/T3 只发摘要 + 文件路径，Agent 用 read 工具读完整内容。
  const { mkdirSync, writeFileSync } = await import("fs");
  const dumpDir = `/tmp/role-train/${slug}`;
  try {
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(`${dumpDir}/IDENTITY.md`, identity);
    writeFileSync(`${dumpDir}/SOUL.md`, soulContent);
    writeFileSync(`${dumpDir}/AGENTS.md`, agentsWithSkills);
  } catch (err) {
    console.warn(`  ⚠️ dump 失败: ${err.message}（Agent 需以嵌入式读全文，可能有死锁风险）`);
  }

  return {
    roleName, roleDesc, roleEmoji, roleColor, slug,
    files: { "IDENTITY.md": identity, "SOUL.md": soulContent, "AGENTS.md": agentsWithSkills },
    soul: soulContent,
    agents: agentsWithSkills,
    recommendedSkills: skillMatch.skills,  // 同时返回结构化数据，供后续使用
    dumpDir,                              // Agent 读完整内容的路径
    fullAgentsPath: `${dumpDir}/AGENTS.md`,
  };
}

// ── Delegate MQTT communication to emqx-mqtt-clients ──────────────────────
// 实际代码在 mqtt-adapter.mjs（薄适配层，~180 行）。
// train-role.mjs 只需要 import 即可，本文件不再包含 exec / JSON 解析细节。

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-/g, "_");
      const val = (i + 1 < process.argv.length && !process.argv[i + 1].startsWith("--"))
        ? process.argv[++i] : true;
      args[key] = val;
    }
  }

  if (!args.role_file) die("请提供 --role-file <路径>");
  const roleFilePath = resolve(args.role_file);
  if (!existsSync(roleFilePath)) die(`角色文件不存在: ${roleFilePath}`);
  log("📄 角色文件", roleFilePath);

  if (!args.agent) die("请提供 --agent <clientId>");
  log("🎯 目标 Agent", args.agent);

  // 解析角色文件
  const content = readFileSync(roleFilePath, "utf-8");
  const fm = parseFrontmatter(content);
  const allSections = getAllSections(content);
  const role = await buildRoleFiles(roleFilePath, fm, allSections);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${role.roleEmoji}  角色:   ${role.roleName}`);
  console.log(`  🆔  ID:     ${role.slug}`);
  console.log(`  📝 描述:   ${role.roleDesc.slice(0, 60)}`);
  console.log(`  📦 段落:   ${Object.keys(allSections).length} 个`);
  console.log(`  🧰 推荐技能: ${(role.recommendedSkills || []).length} 个（已写入 AGENTS.md）`);
  console.log(`${"=".repeat(60)}`);

  if (args.dry_run) {
    console.log(`\n[DRY-RUN] 仅显示规划，不发起训练（v2 对话引导式）`);
    console.log(`\n生成的文件（不直接下发，Agent 自己写）:`);
    console.log(`  IDENTITY.md (${role.files["IDENTITY.md"].length} chars / ${Buffer.byteLength(role.files["IDENTITY.md"], "utf8")} bytes)`);
    console.log(`  SOUL.md     (${role.files["SOUL.md"].length} chars / ${Buffer.byteLength(role.files["SOUL.md"], "utf8")} bytes)`);
    console.log(`  AGENTS.md   (${role.files["AGENTS.md"].length} chars / ${Buffer.byteLength(role.files["AGENTS.md"], "utf8")} bytes)`);
    console.log(`  Dump:  ${role.dumpDir}/`);
    console.log(`\n对话协议预览 (v2: 5 阶段 18 状态，零下发，零死锁):\n`);
    const planner = new ConversationPlanner({
      role, maxTurns: 20, allSections,
    });
    console.log("──── 阶段 1: 问身份 ────");
    console.log("── T1: 问名字/做什么/风格 3 词");
    console.log(planner.planT1Turn());
    console.log("\n──── 阶段 2: 问灵魂 ────");
    console.log("── T2: 问边界/沉默/风格");
    console.log(planner.planT2Turn());
    console.log("\n──── 阶段 3: 问工作流 (3 小轮) ────");
    console.log("── T3A: 步骤");
    console.log(planner.planT3ATurn());
    console.log("\n── T3B: 工具");
    console.log(planner.planT3BTurn());
    console.log("\n── T3C: 例子");
    console.log(planner.planT3CTurn());
    console.log("\n──── 阶段 4: 落盘 (3 子步 + 3 ping) ────");
    console.log("── T4A: 写 IDENTITY");
    console.log(planner.planT4AWrite());
    console.log("\n── T4A_ping: 探测");
    console.log("(ping)");
    console.log("\n── T4B: 写 SOUL");
    console.log(planner.planT4BWrite());
    console.log("\n── T4B_ping: 探测");
    console.log("(ping)");
    console.log("\n── T4C: 写 AGENTS");
    console.log(planner.planT4CWrite());
    console.log("\n── T4C_ping: 探测");
    console.log("(ping)");
    console.log("\n──── 阶段 5: 三层验证 (A+B+C+D) ────");
    console.log("── T5A: Agent 自报 (3 句话)");
    console.log(planner.planT5ATurn());
    console.log("\n── T5B: 硬指标对照清单");
    console.log(planner.planT5BTurn());
    console.log("\n── T5C: 教头 diff + Agent 复述漏点");
    console.log(planner.planT5CTurn());
    console.log("\n── T5D: 补强轮 (T5B 有漏点时进入)");
    // 模拟 T5B 漏 3 条的场景看 T5D 输出
    planner.t5bResults = {
      valid: true,
      results: [
        { check: "背调必须获得候选人书面授权", remembered: false },
        { check: "offer 发放后不随意撤回", remembered: false },
        { check: "试用期时长/薪资必须符合《劳动合同法》", remembered: false },
      ],
    };
    console.log(planner.planT5DTurn());
    console.log("\n[注] T5B 无漏点时跳过 T5D，直接走 T6]");
    console.log("\n── T6: 基础设定收尾 (2026-06-11 增) ──");
    console.log(planner.planT6Turn());
    console.log("\n── T7A: 技能推荐 (2026-06-11 增) ──");
    console.log(planner.planT7ATurn());
    console.log("\n[注] T6 完后如有 recommendedSkills → T7A/B/C 走 T7 装机决策；否则跳过]");
    console.log("\n── T7C: 比对 + 命令 Agent 用 skill_workshop install 安装 ──");
    // 模拟 T7B Agent 报"已装：claw-backup" (一个装一个没装)
    planner.t7bInstalled = "claw-backup";
    console.log(planner.planT7CTurn());
    return;
  }

  if (args.list_skills) {
    console.log(`\n🧰 推荐技能清单 (${role.recommendedSkills.length} 个):`);
    console.log("");
    for (const s of role.recommendedSkills) {
      console.log(`  [${s.score || '必装'}] ${s.name}`);
      console.log(`        path:  ${s.path}`);
      console.log(`        family: ${s.family}`);
      console.log(`        reason: ${s.reason}`);
      console.log("");
    }
    return;
  }

  if (args.dump_files) {
    const dumpDir = resolve(args.dump_files);
    const { mkdirSync, writeFileSync } = await import("fs");
    mkdirSync(dumpDir, { recursive: true });
    writeFileSync(`${dumpDir}/IDENTITY.md`, role.files["IDENTITY.md"]);
    writeFileSync(`${dumpDir}/SOUL.md`, role.files["SOUL.md"]);
    writeFileSync(`${dumpDir}/AGENTS.md`, role.files["AGENTS.md"]);
    console.log(`\n📁 已落盘到 ${dumpDir}/:`);
    console.log(`  IDENTITY.md (${role.files["IDENTITY.md"].length} chars)`);
    console.log(`  SOUL.md     (${role.files["SOUL.md"].length} chars)`);
    console.log(`  AGENTS.md   (${role.files["AGENTS.md"].length} chars)`);
    return;
  }

  // 检查 emqx-mqtt-clients 依赖（在 MqttClient 构造时也会检查，这里仅提前报错）
  try {
    resolveEmqxScript();
  } catch (err) {
    die(err.message);
  }

  const maxTurns = parseInt(args.max_turns, 10) || 34;
  const timeout = parseInt(args.timeout, 10) || 300;
  const idleTimeout = parseInt(args.idle_timeout, 10) || 30;

  console.log(`\n🎓 开始对话式训练`);
  console.log(`   协议: 纯对话（不再发 JSON 协议包）`);
  console.log(`   最大回合: ${maxTurns} | 单次超时: ${timeout}s | 静默窗口: ${idleTimeout}s`);
  console.log(`   MQTT 通讯: 委派给 emqx-mqtt-clients`);
  console.log("");

  // ── Health Check: 训练前先 ping 一下目标 Agent ───────────────────────
  // 背景：openclaw-test 2026-06-10 在训练后陷入死锁，3 个大文件 write
  //   之后不再响应。健康探测可避免在 Agent 已死锁的情况下发一长串
  //   无用消息、浪费 max-turns。
  const skipHealth = args.no_health_check === true || args.no_health_check === "true";
  if (!skipHealth) {
    const pingTimeout = Math.min(20, timeout);
    const pingIdle = Math.min(8, idleTimeout);
    process.stdout.write(`  🩺 训练前健康探测 (ping ${pingTimeout}s)... `);
    const health = await healthCheck({
      agent: args.agent,
      pingMsg: "ping",
      timeout: pingTimeout,
      idleTimeout: pingIdle,
    });
    if (health.ok) {
      const preview = health.reply.length > 60 ? health.reply.slice(0, 60) + "..." : health.reply;
      console.log(`✅ 在线 (${preview})`);
    } else {
      console.log(`❌ 失败`);
      die(`训练前健康探测未通过：${health.error}\n` +
          `   可能原因：\n` +
          `     1. Agent 离线 / 未订阅 ${args.agent}/inbound\n` +
          `     2. Agent 陷入死锁（参见 memory/students/openclaw-test.md 案例）\n` +
          `     3. 网络/认证问题\n` +
          `   诊断命令：node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs\n` +
          `   如确认 Agent 仍可用，可用 --no-health-check 跳过探测。`);
    }
  } else {
    console.log(`  🩺 健康探测已跳过 (--no-health-check)`);
  }

  const mqtt = new MqttClient({
    agent: args.agent,
    timeout,
    idleTimeout,
  });

  const planner = new ConversationPlanner({
    role,
    maxTurns,
    allSections,
    onStateChange: (next, prev, meta) => {
      // 2026-06-11 fix: 不重复 log，planner.transition() 内部已 log
      // 保留 callback 让用户可加自定义逻辑（如：写日志、统计）
    },
    onAgentFeedback: (text) => {
      const preview = text.length > 120 ? text.slice(0, 120) + "..." : text;
      console.log(`     [agent] "${preview.replace(/\n/g, " ")}"`);
    },
  });

  const result = await planner.run(async (planContent) => {
    return mqtt.sendAndAwait(planContent);
  });

  console.log(`\n${"=".repeat(60)}`);
  if (result.success) {
    console.log(`  ✅ 训练成功！`);
  } else {
    console.log(`  ⚠️ 训练未完成: ${result.finalReason || "未知原因"}`);
  }
  console.log(`  📊 总回合: ${result.turns} / ${maxTurns}`);
  console.log(`  📜 最终状态: ${result.state}`);
  console.log(`${"=".repeat(60)}`);

  process.exit(result.success ? 0 : 1);
}

main().catch(err => {
  console.error(`\n❌ Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});