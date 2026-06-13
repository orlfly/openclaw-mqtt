// ═══════════════════════════════════════════════════════════════════════
//  platform-config.mjs — Agent 平台抽象 (2026-06-12 增)
//
//  role-train 通过 platform 抽象与具体 Agent 平台解耦
//  支持 3 层覆盖: role.roleMeta.platform > CLI --platform > env > 默认
//
//  设计目标: 添加新平台 = 加 1 个 BUILTIN_PLATFORMS 条目
// ═══════════════════════════════════════════════════════════════════════

/**
 * 内置平台配置
 *  key = platform id (用于 CLI --platform <id> 和 env ROLE_TRAIN_PLATFORM)
 *  value = 该平台的 platform 设定
 */
export const BUILTIN_PLATFORMS = {
  // OpenClaw 标准平台 (教头自己用)
  // 2026-06-12 修: 装机命令从虚构的 skill_workshop 改成真实的 openclaw skills install
  // ClawHub 装机成功标志: "Downloading <slug>@<ver>" 或 "Installed <slug>@<ver> -> <path>"
  openclaw: {
    id: "openclaw",
    skillDirs: ["~/.openclaw/workspace/skills/", "~/.openclaw/skills/"],
    installCommand: "openclaw skills install {id}",
    installAckPattern: /(?:Downloading|Installed)\s+(\S+?)@/,
    installAckFormat: "Downloading/Installed <id>@<ver>",
    defaultSenderId: "openclaw-agent",
    fileLayout: "openclaw-triple",  // IDENTITY/SOUL/AGENTS 三件套
  },

  // 通用平台 (其他 Agent)
  generic: {
    id: "generic",
    skillDirs: ["./skills/", "./workspace/skills/"],
    installCommand: "install-skill {id}",
    installAckPattern: /installed:\s*(\S+)/i,
    installAckFormat: "installed: <id>",
    defaultSenderId: "trainer",
    fileLayout: "openclaw-triple",  // 默认仍用 OpenClaw 文件结构 (role-train 的核心假设)
  },
};

/**
 * 解析 platform 配置 (3 层覆盖)
 * @param {Object} [opts]
 * @param {string} [opts.cliPlatform] - CLI 传的 --platform 值
 * @param {Object} [opts.roleMeta] - role.roleMeta.platform
 * @param {string} [opts.envPlatform] - env ROLE_TRAIN_PLATFORM
 * @returns {Object} platform config
 */
export function resolvePlatform({ cliPlatform, roleMeta, envPlatform } = {}) {
  // 优先级: cliPlatform > roleMeta.id > envPlatform > "openclaw"
  const id = cliPlatform || roleMeta?.id || envPlatform || process.env.ROLE_TRAIN_PLATFORM || "openclaw";
  const builtin = BUILTIN_PLATFORMS[id];
  if (!builtin) {
    const known = Object.keys(BUILTIN_PLATFORMS).join(", ");
    throw new Error(
      `未知 platform: "${id}"。已知: ${known}。\n` +
      `提示: --platform <id> 或 role.roleMeta.platform.id = "<id>"`
    );
  }
  // roleMeta 字段覆盖 (细粒度)
  const merged = { ...builtin };
  if (roleMeta) {
    if (roleMeta.skillDirs) merged.skillDirs = roleMeta.skillDirs;
    if (roleMeta.installCommand) merged.installCommand = roleMeta.installCommand;
    if (roleMeta.installAckPattern) merged.installAckPattern = roleMeta.installAckPattern;
    if (roleMeta.installAckFormat) merged.installAckFormat = roleMeta.installAckFormat;
    if (roleMeta.defaultSenderId) merged.defaultSenderId = roleMeta.defaultSenderId;
    if (roleMeta.fileLayout) merged.fileLayout = roleMeta.fileLayout;
  }
  return merged;
}

/**
 * 格式化 install 命令 (替换 {id} 占位符)
 */
export function formatInstallCommand(platform, skillId) {
  return platform.installCommand.replace(/\{id\}/g, skillId);
}

/**
 * 列出 platform 路径的提示文本 (用于 T7A/T7D prompt)
 * @returns {string} "查 ~/.openclaw/skills/ 或 ~/.openclaw/workspace/skills/ 目录"
 */
export function formatSkillDirHints(platform) {
  return platform.skillDirs.map(d => `\`${d}\``).join(" 或 ");
}
