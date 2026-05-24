---
name: emqx-mqtt-clients
description: Discover MQTT agents connected to an EMQX broker, check agent presence, get MQTT connectivity endpoints for cross-agent communication, watch for agents joining/leaving the broker, and distribute tasks to agents via MQTT. Use when you need agent discovery, presence monitoring, or cross-agent MQTT task distribution.
---

# EMQX MQTT Agent Discovery & Task Distribution

Discover MQTT-connected agents on EMQX, communicate with them, and route replies across channels.

---

## 安装设置（Installation & Setup）

> [!NOTE]
> API Key 需要 **administrator** 或 **viewer** 角色。

---

## 安装设置（Installation & Setup）

需要配置以下信息：

**EMQX 连接（5 项）：**

| 配置项 | 环境变量 | 说明 |
|--------|---------|------|
| EMQX 地址 | `EMQX_HOST` | Broker 主机地址（API 和 MQTT 共用） |
| MQTT 端口 | `EMQX_MQTT_PORT` | 默认 1883 |
| API 端口 | `EMQX_API_PORT` | 默认 18083 |
| API Key ID | `EMQX_API_KEY` | API 认证凭据 ID |
| API Key Secret | `EMQX_API_SECRET` | API 认证凭据密钥 |

**Agent 身份：**

| 配置项 | 环境变量 | 说明 |
|--------|---------|------|
| Agent ID | `EMQX_SENDER_ID` | 唯一标识符，如 `openclaw-malong` |
| 显示名称 | `EMQX_SENDER_NAME` | 如 `马龙 🛠️` |
| 头像 Emoji | `EMQX_SENDER_EMOJI` | 如 `🛠️` |
| 描述/角色 | `EMQX_SENDER_DESC` | 如 `开发管理` |

**消息订阅：**

| 配置项 | 环境变量 | 说明 |
|--------|---------|------|
| 订阅 Topic | `EMQX_SUBSCRIBE_TOPIC` | 接收消息的 topic，默认 `{senderId}/inbound` |

---

### 方式一：交互式安装向导（推荐）

```bash
cd ~/.openclaw/workspace
bash skills/emqx-mqtt-clients/scripts/setup.sh
```

脚本会依次引导填写：
1. **EMQX 连接** — 地址、MQTT 端口、API 端口、Key ID、Secret
2. **Agent 身份** — ID、名称、Emoji、描述
3. **订阅 Topic** — 消息接收地址
4. 写入 `~/.openclaw/workspace/.env` 并自动验证连接

### 方式二：手动 export（适合 CI / 容器）

```bash
# EMQX 连接（5 项）
export EMQX_HOST="localhost"
export EMQX_MQTT_PORT="1883"
export EMQX_API_PORT="18083"
export EMQX_API_KEY="<api-key-id>"
export EMQX_API_SECRET="<api-secret-key>"

# Agent 身份
export EMQX_SENDER_ID="openclaw-malong"
export EMQX_SENDER_NAME="马龙 🛠️"
export EMQX_SENDER_EMOJI="🛠️"
export EMQX_SENDER_DESC="开发管理"

# 消息订阅
export EMQX_SUBSCRIBE_TOPIC="openclaw-malong/inbound"
```

### 方式三：`.env` 文件

创建 `~/.openclaw/workspace/.env`，内容格式同上。脚本和 skill 会自动读取。

---

## 验证配置

```bash
cd ~/.openclaw/workspace
set -a; source .env 2>/dev/null; set +a
python3 skills/emqx-mqtt-clients/scripts/emqx_list_clients.py
```

显示 agent 列表即配置成功。

---

## 1. Agent Discovery

### List all connected agents

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_list_clients.py
```

### Discover with inbound topic info

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py discover
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py discover --filter "openclaw-"
```

### Check agent's subscribed topics

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py subs openclaw-doc
```

---

## 2. Cross-Channel Task Distribution

### Send & Wait (reply routing built-in)

**`send-wait`** — the key command for cross-channel scenarios.
Uses MQTT v5 userProperties to carry sender identity and reply routing.
Sends a task with `reply_to` in userProperties, subscribes to that topic and blocks until the agent replies.

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send-wait \
  --agent openclaw-doc --task status --timeout 30
```

The agent receives the task with:
- **userProperties**: `name`, `description`, `emoji`, `reply_to=agent-reply/<id>`
- Agent should publish its response to the `reply_to` topic in userProperties

### Fire & Forget

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send \
  --agent openclaw-doc --msg "请检查系统状态"

python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send \
  --agent openclaw-doc --task health
```

### Custom tasks with parameters

```bash
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send-wait \
  --agent openclaw-doc --task custom \
  --params '{"action": "report", "level": "full"}' \
  --timeout 30
```

### Identity customization

```bash
# Override sender identity per-command
python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send \
  --agent openclaw-doc --msg "hello" \
  --sender-name "马龙 🛠️" --sender-emoji "🛠️" --sender-desc "开发管理"
```

---

## 3. Cross-Channel Reply Routing (QQ Bot ←→ MQTT)

The core pattern for routing MQTT agent replies back to QQ Bot:

```python
# Step 1: Send task with reply_wait, get the reply payload
reply_json = exec("""
  python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send-wait \\
    --agent openclaw-doc --task status --timeout 30
""")

# Step 2: Forward reply to QQ Bot user
message(
    action="send",
    channel="qqbot",        # or whatever incoming channel
    target="<user/group>",
    message=reply_json
)
```

**The routing flow:**

```
User in QQ Bot ──→ 马龙 ──→ MQTT publish (with reply_topic)
                             → Agent processes
                             → Agent publishes reply to reply_topic
                                ↓
马龙 subscribes to reply_topic ←─┘
      ↓
马龙 forward reply via message(channel="qqbot")
      ↓
User sees reply in QQ Bot
```

### Workflow: From any channel to MQTT and back

```python
# 1. User asks in QQ Bot: "看看 openclaw-doc 的状态"

# 2. Send task and wait for reply via MQTT
reply = exec("python3 skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.py send-wait --agent openclaw-doc --task status --timeout 15")

# 3. Check if we got a reply
if "No reply received" in reply:
    message(channel="qqbot", ..., message="openclaw-doc 没有响应")
else:
    message(channel="qqbot", ..., message=reply)
```

---

## MQTT v5 Protocol & Message Format (mqtt-chat compatible)

The script follows the mqtt-chat app conventions for full interoperability.

### Wire Protocol

- **MQTT version**: v5
- **Topic**: `{targetClientId}/inbound` (private messages)
- **userProperties**: Sender identity & reply routing

### userProperties (MQTT v5 header)

```
name: 马龙 🛠️
emoji: 🛠️
description: 开发管理
reply_to: openclaw-malong/inbound
```

The receiver uses these to identify the sender and knows where to reply.

### Message Body (JSON)

```json
{
  "id": "a1b2c3d4e5f6",
  "text": "Request agent status report",
  "senderId": "openclaw-malong",
  "timestamp": "2026-05-24T21:22:00.000000",
  "type": "text",
  "kind": "task",
  "action": "status_report",
  "task_name": "status",
  "description": "Request agent status report",
  "reply_to": {
    "topic": "agent-reply/a1b2c3d4e5f6"
  },
  "payload": {}
}
```

This is the same format used by the MQTT Chat app, so agents built for that app can respond to tasks from this tool.

---

## Scripts Reference

| Script | Commands | Purpose |
|--------|----------|---------|
| `emqx_list_clients.py` | — | Discover agents, watch presence, list endpoints |
| `emqx_agent_communicate.py` | `subs` | Check agent subscriptions |
| | `send` | Fire-and-forget message/task |
| | `send-wait` | Send task + wait for reply (blocking) |
| | `discover` | List agents with inbound topic details |

---

## Agent Communication Convention

| Direction | Topic Pattern | Example |
|-----------|---------------|---------|
| Inbound (receive) | `{clientid}/inbound` | `openclaw-doc/inbound` |
| Reply (response) | `reply_to` in userProperties + body | `openclaw-malong/inbound` / `agent-reply/a1b2c3d4e5f6` |
