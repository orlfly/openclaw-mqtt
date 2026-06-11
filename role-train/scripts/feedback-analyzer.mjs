/**
 * feedback-analyzer.mjs — 分析目标 Agent 的回复，分类并决定下一步动作
 *
 * 用于"对话式"训练模式：Agent 不实现 type:"role-train" 协议，
 * 它用自然语言回复。分类器要识别这些自然语言：
 *
 *   CONFIRMED  - 明确收到/理解（"已收到"、"明白了"、"好的"、"已应用"）
 *   VERIFIED   - 自我报告身份（"我是<角色>"、"我的角色是"）
 *   QUESTION   - 提出问题（末尾问号、"怎么"、"什么是"）
 *   ERROR      - 报错（"失败"、"无法"、"不能"）
 *   NEED_MORE  - 需要更多内容
 *   UNCLEAR    - 无法分类
 */

// 自然语言中的"我已收到/明白"等表达
const CONFIRMED_PATTERNS = [
  /已应用/, /已加载/, /已设置/, /已写入/, /已收到/, /已写/, /写入完成/,
  /明白了/, /了解/, /确认/, /成功/, /完成/,
  /好的/, /好的[，,。]/, /收到/, /ack/i, /ok/i, /okay/i, /done/i, /received/i, /understood/i,
];

// 自然语言中的"我是XX角色" / "我的角色是XX"
const VERIFIED_PATTERNS = [
  /我是[一-龥A-Za-z]{2,}/,             // "我是招聘专家"
  /我的角色/, /我的身份/, /我的职责/, /我的使命/,
  /身份是/, /职位是/, /担任/,
  /我现在的角色/, /当前角色/, /当前身份/,
  /i am (a|an|the)\b/i, /my role/i, /i'm a/i, /i'm an/i,
];

const QUESTION_PATTERNS = [
  /\?$/m, /\？$/m,
  /怎么/, /如何/, /怎样/, /为什么/, /什么是/, /哪个/, /哪些/,
  /意思/, /解释/, /说明/, /能不能/, /能否/, /可否/,
  /what is/i, /how (to|do|can)/i, /why/i, /explain/i,
];

const ERROR_PATTERNS = [
  /失败/, /错误/, /无法/, /不能/, /不可/, /missing/i, /error/i,
  /fail/i, /unable/i, /cannot/i, /denied/i, /not found/i,
  /异常/, /崩溃/, /crash/i,
];

const NEED_MORE_PATTERNS = [
  /还需要/, /请补充/, /更多/, /不足/, /不够/, /太简/, /不够详细/,
  /缺少/, /再发/, /再一次/, /再来/, /重新/,
  /need more/i, /more detail/i, /elaborate/i, /insufficient/i,
];

/**
 * 分类 Agent 回复
 * @param {string} text
 * @param {string} expectedRoleName
 * @returns {{type, confidence, reason, matchedRole?}}
 */
export function classifyFeedback(text, expectedRoleName) {
  if (!text || text.trim().length === 0) {
    return { type: "UNCLEAR", confidence: 0, reason: "empty response" };
  }

  // VERIFIED 优先（如果 agent 明确说"我是XX"）
  for (const pat of VERIFIED_PATTERNS) {
    if (pat.test(text)) {
      const matchesRole = expectedRoleName && text.includes(expectedRoleName);
      return {
        type: "VERIFIED",
        confidence: matchesRole ? 0.95 : 0.7,
        reason: matchesRole ? `mentions expected role "${expectedRoleName}"` : "self-identifies as a role",
        matchedRole: matchesRole,
      };
    }
  }

  // 计算各类别命中数
  const counts = {
    CONFIRMED: 0,
    QUESTION: 0,
    ERROR: 0,
    NEED_MORE: 0,
  };

  for (const pat of CONFIRMED_PATTERNS) if (pat.test(text)) counts.CONFIRMED++;
  for (const pat of QUESTION_PATTERNS) if (pat.test(text)) counts.QUESTION++;
  for (const pat of ERROR_PATTERNS) if (pat.test(text)) counts.ERROR++;
  for (const pat of NEED_MORE_PATTERNS) if (pat.test(text)) counts.NEED_MORE++;

  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const [topType, topCount] = sorted[0];

  if (topCount === 0) {
    return { type: "UNCLEAR", confidence: 0.3, reason: "no pattern matched" };
  }

  const total = sorted.reduce((sum, [, c]) => sum + c, 0);
  const confidence = topCount / total;

  return {
    type: topType,
    confidence,
    reason: `matched ${topCount} pattern(s) for ${topType}`,
    counts,
  };
}

/**
 * 根据反馈类型决定下一步策略
 *
 * 注意：对话式模式不再由 analyzer 直接生成 payload，
 * 而是把决策返回给 planner，让 planner 生成具体的下一轮文本。
 * analyzer 只给出 action 名称和 reason。
 *
 * @returns {{action: 'COMPLETE' | 'ABORT' | 'PROCEED' | 'RETRY', reason: string}}
 */
export function decideNextAction(classification, state) {
  const { type, confidence, reason } = classification;
  const { turn, maxTurns } = state;

  if (turn >= maxTurns) {
    return { action: "ABORT", reason: `reached max turns (${maxTurns}/${maxTurns})` };
  }

  switch (type) {
    case "VERIFIED":
      return { action: "COMPLETE", reason: reason || "agent verified" };
    case "CONFIRMED":
      return { action: "PROCEED", reason: `agent confirmed (${reason})` };
    case "QUESTION":
      return { action: "PROCEED", reason: `agent asked a question; planner will adjust` };
    case "ERROR":
      return { action: "RETRY", reason: `agent reported error (${reason})` };
    case "NEED_MORE":
      return { action: "PROCEED", reason: `agent wants more (${reason})` };
    case "UNCLEAR":
    default:
      // 在对话式模式下，UNCLEAR 也有可能是 agent 在做大量复述（没匹配上但其实有效）
      // 给 planner 机会决定，不再硬 ABORT
      return { action: "RETRY", reason: `unclear (${reason})` };
  }
}
