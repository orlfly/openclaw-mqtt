#!/usr/bin/env bash
# ==============================================================
# EMQX MQTT Clients Skill — 安装设置向导
# ==============================================================
# 引导用户配置 EMQX 连接信息及 agent 身份标识。
# 配置写入 ~/.openclaw/workspace/.env
# 使用 Node.js + MQTT.js 脚本验证连接
# ==============================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$(cd "$SKILL_DIR/../../.." && pwd)/.env"

echo "============================================"
echo "  EMQX MQTT 客户端 Agent 安装设置"
echo "  (Node.js + MQTT.js)"
echo "============================================"
echo ""
echo "需要配置以下信息："
echo ""
echo "  [EMQX 连接]  地址 | MQTT 端口 | API 端口 | API Key ID | Secret"
echo "  [Agent 身份]  ID | 名称 | Emoji | 描述"
echo "  [消息订阅]   订阅 Topic"
echo ""

# ── 1. EMQX 连接 ─────────────────────────────────────────
echo "————————————————————————————"
echo "【1/3】EMQX 连接信息"
echo "————————————————————————————"
echo ""

# EMQX 地址（API 和 MQTT 共用）
current="${EMQX_HOST:-}"
read -r -p "EMQX 地址 [${current:-localhost}]: " input
EMQX_HOST="${input:-${current:-localhost}}"

# MQTT 端口
current="${EMQX_MQTT_PORT:-1883}"
read -r -p "MQTT 端口 [${current}]: " input
EMQX_MQTT_PORT="${input:-${current}}"

# API 端口
current="${EMQX_API_PORT:-18083}"
read -r -p "API 端口 [${current}]: " input
EMQX_API_PORT="${input:-${current}}"

# API Key ID
current="${EMQX_API_KEY:-}"
read -r -p "API Key ID [${current}]: " input
EMQX_API_KEY="${input:-${current}}"

# API Key Secret
current="${EMQX_API_SECRET:-}"
prompt="API Key Secret"
if [ -n "$current" ]; then
  prompt="$prompt [**** (已设置)]"
fi
read -r -s -p "${prompt}: " input
echo ""
EMQX_API_SECRET="${input:-${EMQX_API_SECRET:-}}"

# ── 2. Agent 身份标识 ─────────────────────────────────────
echo ""
echo "————————————————————————————"
echo "【2/3】Agent 身份标识"
echo "————————————————————————————"
echo "这些信息在与其他 agent 通讯时标识你的身份。"
echo ""

current="${EMQX_SENDER_ID:-openclaw-main}"
read -r -p "Agent ID (唯一标识符，如 openclaw-malong) [${current}]: " input
EMQX_SENDER_ID="${input:-${current}}"

current="${EMQX_SENDER_NAME:-}"
read -r -p "显示名称 (如 马龙 🛠️) [${current}]: " input
EMQX_SENDER_NAME="${input:-${current}}"

current="${EMQX_SENDER_EMOJI:-🤖}"
read -r -p "头像 Emoji [${current}]: " input
EMQX_SENDER_EMOJI="${input:-${current}}"

current="${EMQX_SENDER_DESC:-}"
read -r -p "描述/角色 (如 开发管理) [${current}]: " input
EMQX_SENDER_DESC="${input:-${current}}"

# ── 3. 订阅 Topic ─────────────────────────────────────────
echo ""
echo "————————————————————————————"
echo "【3/3】消息接收设置"
echo "————————————————————————————"
echo "默认接收 topic 为 {agentId}/inbound，"
echo "其他 agent 向此 topic 发送消息来与你通讯。"
echo ""

default_topic="${EMQX_SENDER_ID}/inbound"
current="${EMQX_SUBSCRIBE_TOPIC:-$default_topic}"
read -r -p "订阅 Topic [${current}]: " input
EMQX_SUBSCRIBE_TOPIC="${input:-${current}}"

# ── 写入 .env ─────────────────────────────────────────────
echo ""
echo "————————————————————————————"
echo "写入配置..."
echo "————————————————————————————"

cat > "$ENV_FILE" << ENVEOF
# =======================================
# EMQX MQTT Client Skill — 自动生成
# 运行 scripts/setup.sh 重新配置
# =======================================

# EMQX 连接
EMQX_HOST=${EMQX_HOST}
EMQX_MQTT_PORT=${EMQX_MQTT_PORT}
EMQX_API_PORT=${EMQX_API_PORT}
EMQX_API_KEY=${EMQX_API_KEY}
EMQX_API_SECRET=${EMQX_API_SECRET}

# Agent 身份
EMQX_SENDER_ID=${EMQX_SENDER_ID}
EMQX_SENDER_NAME=${EMQX_SENDER_NAME}
EMQX_SENDER_EMOJI=${EMQX_SENDER_EMOJI}
EMQX_SENDER_DESC=${EMQX_SENDER_DESC}

# 消息订阅
EMQX_SUBSCRIBE_TOPIC=${EMQX_SUBSCRIBE_TOPIC}
ENVEOF

echo "已写入: $ENV_FILE"
echo ""

# ── 验证 ──────────────────────────────────────────────────
echo "————————————————————————————"
echo "验证连接..."
echo "————————————————————————————"

export EMQX_HOST EMQX_MQTT_PORT EMQX_API_PORT
export EMQX_API_KEY EMQX_API_SECRET
export EMQX_SENDER_ID EMQX_SENDER_NAME EMQX_SENDER_EMOJI EMQX_SENDER_DESC
export EMQX_SUBSCRIBE_TOPIC

if node "$SCRIPT_DIR/emqx_list_clients.mjs" --summary 2>/dev/null; then
    echo "✅ EMQX 连接成功！"
else
    echo "⚠️  连接失败，请检查 EMQX 地址和认证信息。"
    echo "   可重新运行 setup.sh 或直接编辑 $ENV_FILE"
fi

echo ""
echo "============================================"
echo "  设置完成"
echo "============================================"
echo ""
echo "EMQX 地址:     ${EMQX_HOST}:${EMQX_MQTT_PORT} (MQTT) / ${EMQX_API_PORT} (API)"
echo "Agent 标识:    ${EMQX_SENDER_NAME} (${EMQX_SENDER_ID})"
echo "接收 Topic:    ${EMQX_SUBSCRIBE_TOPIC}"
echo ""
echo "查看在线 agent:"
echo "  source $ENV_FILE && node $SCRIPT_DIR/emqx_list_clients.mjs"
echo ""
