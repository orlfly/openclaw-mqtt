/**
 * skill-matcher.mjs — 根据角色描述自动匹配所需 skill
 *
 * 用法：
 *   import { matchSkillsForRole, buildSkillsSection } from "./skill-matcher.mjs";
 *   const matches = matchSkillsForRole({ roleName, roleDesc, soulContent, agentsContent });
 *   const section = buildSkillsSection(matches);
 *
 * 策略：
 *   1. 关键词匹配：把角色内容 + 60 个 skill 的 tags 做交集打分
 *   2. 能力族映射：根据"研发/营销/金融/法务"等关键字做家族加分
 *   3. 基础技能：每个角色必装"claw-backup"（基础备份）
 *   4. 输出 Markdown 段，可直接拼到 AGENTS.md
 */

import { readFileSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");

// ── 加载清单 ────────────────────────────────────────────────────────────

let _shortlistCache = null;
function loadShortlist() {
  if (_shortlistCache) return _shortlistCache;
  const path = resolve(SKILL_DIR, "skill-shortlist.json");
  if (!existsSync(path)) {
    throw new Error(`skill-shortlist.json not found at ${path}`);
  }
  _shortlistCache = JSON.parse(readFileSync(path, "utf-8"));
  return _shortlistCache;
}

// ── 基础必装（每个角色都装） ──────────────────────────────────────────────

const MUST_HAVE = [
  { id: "claw-backup", reason: "工作区备份是所有 agent 长期运行的基础" },
  { id: "skill-creator", reason: "元能力：可以自己创建/审阅 skill" },
];

// ── 家族权重：让角色所属部门更容易命中对应家族 ───────────────────────────

const FAMILY_AFFINITY = {
  // 部门关键词 → 家族加分（按部门实际工作场景给最小集）
  "engineering|研发|开发|dev|工程|sde|sre|devops|ai|ml|qa|测试|固件|嵌入式|驱动|fpga|机械": ["browser", "workflow", "office", "pdf", "excel", "qa", "rag", "meta", "infra"],
  "design|设计|ui|ux|brand|visual|品牌": ["browser", "office", "rag", "writing", "translation"],
  "marketing|营销|运营|增长|seo|aso|社媒": ["browser", "workflow", "intel", "marketing", "analytics", "office", "writing", "rag"],
  "sales|销售|bd|outbound|售前|赢单|pipeline|投标|proposal": ["browser", "workflow", "marketing", "analytics", "rag", "office"],
  "finance|金融|财务|投资|估值|股票|基金|风控|税务|簿记|记账|发票|会计|fp&a|簿记": ["excel", "finance-stock", "finance-tax", "finance-risk", "rag", "office", "pdf"],
  "hr|人力|招聘|绩效|培训|onboarding|入职|jd|简历|面试|offer|猎聘|拉勾|boss直聘|薪酬|谈薪|候选人": ["rag", "office", "legal", "writing"],
  "legal|法务|合规|律师|policy|制度|合规": ["legal", "rag", "pdf", "office", "compliance"],
  "supply|供应|采购|物流|库存|供应商": ["excel", "analytics", "workflow"],
  "product|产品|trend|sprint|行为|助推|反馈": ["rag", "analytics", "office", "writing", "intel"],
  "project|项目|pm|牧羊人|制片人|jira": ["workflow", "office", "analytics", "infra"],
  "test|qa|测试|质量|无障碍|accessibility|evidence|reality": ["qa", "rag", "office", "analytics"],
  "support|客服|支持|responder|合规|backup|infra": ["rag", "office", "browser", "notification"],
  "academic|学术|研究|历史|人类学|心理|地理|文学|narrat": ["research", "rag", "office", "writing", "translation"],
  "game|游戏|unity|unreal|godot|roblox|blender|narrat": ["office", "qa", "workflow", "rag"],
  "spatial|空间|ar|vr|3d|vision|visionos|spatial": ["office", "rag"],
  "specialized|专项|agent|orchestrat|chief|govern|顾问|steward|translat|builder|architect|coordinator|producer|tracker": ["workflow", "rag", "meta", "office", "browser", "infra"],
};

// ── 关键词→家族强匹配（角色描述里出现"投资/股票/合同"等直接命中） ──────

const KEYWORD_FAMILY = [
  { kws: ["投资", "股票", "估值", "a股", "港股", "美股", "基金经理", "投资组合", "投资研究", "研报", "二级思考"], family: "finance-stock" },
  { kws: ["风控", "仓位", "drawdown", "var", "cvar", "rug pull", "solidity", "区块链", "智能合约"], family: "finance-risk" },
  { kws: ["税", "税务", "发票", "簿记", "记账", "会计", "复式", "增值税", "金税"], family: "finance-tax" },
  { kws: ["合同", "审查", "条款", "民法典"], family: "legal" },
  { kws: ["劳动法", "加班", "休假", "赔偿", "裁员"], family: "legal" },
  { kws: ["合规", "compliance", "ftc", "hipaa", "gdpr", "隐私", "保ail", "数据合规", "pipl", "个人信息保护"], family: "compliance" },
  { kws: ["pdf", "合同pdf", "扫描件"], family: "pdf" },
  { kws: ["excel", "xlsx", "表格", "csv", "对账", "账务"], family: "excel" },
  { kws: ["rag", "知识库", "检索", "召回", "语义", "embedding"], family: "rag" },
  { kws: ["新闻", "情报", "简报", "每日", "早报", "舆情"], family: "intel" },
  { kws: ["浏览器", "网页", "登录态", "playwright", "selenium", "抓取", "scraping", "小红书", "抖音", "推特", "twitter", "instagram", "reddit", "微博"], family: "browser" },
  { kws: ["n8n", "工作流", "orchestrat", "多agent", "调度", "编排"], family: "workflow" },
  { kws: ["ppt", "pptx", "word", "docx", "报告生成", "排版", "汇报", "presentation", "deck"], family: "office" },
  { kws: ["公众号", "wechat", "写文章", "写作", "撰写", "教程"], family: "writing" },
  { kws: ["翻译", "translate", "中英", "出海", "跨境"], family: "translation" },
  { kws: ["学术", "academic", "研究方法", "论文", "文献"], family: "research" },
  { kws: ["cron", "定时", "schedul", "巡检", "定时任务", "持续监测"], family: "cron" },
  { kws: ["邮件", "email", "通知", "通知发送"], family: "notification" },
  { kws: ["mcp", "飞书", "钉钉", "企微", "集成", "对接", "开放平台"], family: "integration" },
  { kws: ["qa", "测试", "审计", "代码审查", "review", "pr review", "质量保障"], family: "qa" },
  { kws: ["kpi", "指标", "漏斗", "dashboard", "bi", "归因"], family: "analytics" },
  { kws: ["lead", "线索", "b2b", "outbound", "cold email", "展会", "会议"], family: "sales" },
  { kws: ["营销", "增长", "seo", "aso", "广告投放", "硬广告", "社媒", "种草", "私域", "裂变", "留存", "激活", "营销渠道", "营销策略"], family: "marketing" },
  { kws: ["备份", "workspace", "安全", "api key", "硬编码"], family: "infra" },
];

// ── 主匹配函数 ──────────────────────────────────────────────────────────

/**
 * 根据角色描述匹配应该装哪些 skill
 * @param {Object} role
 * @param {string} role.roleName
 * @param {string} role.roleDesc
 * @param {string} role.soul
 * @param {string} role.agents
 * @returns {Array<{id, name, path, family, score, reason}>}
 */
export function matchSkillsForRole(role) {
  const text = [
    role.roleName || "",
    role.roleDesc || "",
    role.soul || "",
    role.agents || "",
  ].join(" ").toLowerCase();

  const shortlist = loadShortlist();
  const skills = shortlist.skills;

  // 1. 家族命中（按 KEYWORD_FAMILY 关键词 + FAMILY_AFFINITY 部门亲和）
  const familyHits = new Map();

  // KEYWORD_FAMILY：业务词直接命中家族
  for (const { kws, family } of KEYWORD_FAMILY) {
    for (const kw of kws) {
      if (text.includes(kw.toLowerCase())) {
        familyHits.set(family, (familyHits.get(family) || 0) + 2);
        break;
      }
    }
  }

  // FAMILY_AFFINITY：部门词赋予该部门所有常用家族（+1，仅限同部门）
  for (const [pattern, families] of Object.entries(FAMILY_AFFINITY)) {
    const parts = pattern.split("|");
    const hit = parts.some(p => text.includes(p.toLowerCase()));
    if (hit) {
      for (const fam of families) {
        familyHits.set(fam, (familyHits.get(fam) || 0) + 1);
      }
    }
  }

  // 2. 直接 tag 命中
  const scored = skills.map(s => {
    let score = 0;
    let reason = "";

    // tag 命中：每命中一个 tag +1
    const tagHits = s.tags.filter(t => text.includes(t.toLowerCase()));
    if (tagHits.length > 0) {
      score += tagHits.length;
      reason = `关键词命中: ${tagHits.slice(0, 3).join("/")}`;
    }

    // 家族命中
    if (familyHits.has(s.family)) {
      score += familyHits.get(s.family);
      if (!reason) reason = `能力族命中: ${s.family}`;
    }

    return { ...s, score, reason };
  });

  // 3. 排序取 Top N
  //  策略：不同能力族优先，同族最多 2 个（避免 office/rag 这种大族吐一堆）
  const familyCount = new Map();
  const topN = [];
  for (const s of scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score || (b.downloads + b.installs) - (a.downloads + a.installs))) {
    const count = familyCount.get(s.family) || 0;
    if (count >= 2) continue;  // 同族 ≤ 2
    topN.push(s);
    familyCount.set(s.family, count + 1);
    if (topN.length >= 10) break;
  }

  // 4. 加上 MUST_HAVE（去重）
  const result = [...topN];
  for (const m of MUST_HAVE) {
    if (!result.find(r => r.id === m.id)) {
      const sk = skills.find(s => s.id === m.id);
      if (sk) result.push({ ...sk, score: 0, reason: m.reason });
    }
  }

  return result;
}

// ── 生成 Markdown 段 ────────────────────────────────────────────────────

/**
 * 把匹配结果生成可拼接到 AGENTS.md 的 Markdown 段
 */
export function buildSkillsSection(matches) {
  if (!matches || matches.length === 0) return "";

  const lines = [
    "",
    "---",
    "",
    "## 🧰 我需要的技能 (Recommended Skills)",
    "",
    `> 由 role-train 的 skill-matcher 自动生成，共 ${matches.length} 个。`,
    `> 训练完成后，可由教头/管理员参考这份清单逐个安装。`,
    "",
    "| Skill | 能力族 | 路径 | 评分 | 理由 |",
    "|---|---|---|---|---|",
  ];

  for (const m of matches) {
    const score = m.score || "必装";
    const family = m.family || "—";
    lines.push(`| **${m.name}** | ${family} | \`${m.path}\` | ${score} | ${m.reason || "—"} |`);
  }

  lines.push("");
  lines.push("**安装命令参考**（每行一个 skill）：");
  lines.push("");
  lines.push("```bash");
  for (const m of matches) {
    lines.push(`claw-skill install ${m.path}`);
  }
  lines.push("```");
  lines.push("");
  lines.push("**安装后自检**：");
  lines.push("");
  lines.push("```bash");
  lines.push("# 在 agent 工作目录里");
  lines.push("ls -la ~/.openclaw/skills/  # 确认已安装");
  lines.push("claw-skill list --installed  # 或通过 CLI 查看");
  lines.push("```");

  return lines.join("\n");
}

// ── 便捷函数：一步到位 ──────────────────────────────────────────────────

/**
 * 一步生成完整段（匹配 + Markdown）
 */
export function buildRecommendedSkillsSection(role) {
  const matches = matchSkillsForRole(role);
  return {
    skills: matches,
    markdown: buildSkillsSection(matches),
  };
}

// CLI 测试入口
if (import.meta.url === `file://${process.argv[1]}`) {
  const test = {
    roleName: process.argv[2] || "招聘专家",
    roleDesc: "深耕中国人才市场的全流程招聘专家",
    soul: "精通 Boss 直聘、猎聘、拉勾等主流招聘渠道运营。JD 撰写、简历筛选、面试评估、Offer 谈判。",
    agents: "工作流程：需求对齐 → JD 撰写 → 渠道发布 → 简历筛选 → 面试评估 → 谈薪。",
  };
  const r = buildRecommendedSkillsSection(test);
  console.log("Matched:", r.skills.map(s => `${s.name} (${s.score})`).join("\n  "));
  console.log("\n--- Markdown ---");
  console.log(r.markdown);
}
