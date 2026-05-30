---
name: emqx-mqtt-clients
description: Discover MQTT agents connected to an EMQX broker, check agent presence, get MQTT connectivity endpoints for cross-agent communication, watch for agents joining/leaving the broker, and distribute tasks to agents via MQTT. Use when you need agent discovery, presence monitoring, or cross-agent MQTT task distribution.
---

# EMQX MQTT Agent Discovery & Task Distribution

Discover MQTT-connected agents on EMQX, communicate with them, and route replies across channels.

Uses **MQTT.js** (Node.js) with the **mqtt-chat** wire protocol for full interoperability.

> [!NOTE]
> API Key needs **administrator** or **viewer** role.

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

> **依赖**: 需要 `mqtt` npm 包。如果项目根目录已有 `node_modules/mqtt`，无需额外安装。

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
```

### 方式三：`.env` 文件

创建 `~/.openclaw/workspace/.env`，内容格式同上。脚本和 skill 会自动读取。

---

## 验证配置

```bash
cd ~/.openclaw/workspace
set -a; source .env 2>/dev/null; set +a
node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs
```

显示 agent 列表即配置成功。

---

## 1. Agent Discovery

### List all connected agents

```bash
node skills/emqx-mqtt-clients/scripts/emqx_list_clients.mjs
```

### Discover with inbound topic info

```bash
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs discover
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs discover --filter "openclaw-"
```

### Check agent's subscribed topics

```bash
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs subs openclaw-doc
```

---

## 2. Cross-Channel Task Distribution

### Send & Wait (reply routing built-in)

**`send-wait`** — the key command for cross-channel scenarios.
Uses MQTT v5 userProperties to carry sender identity and reply routing.
Sends a task with `reply_to` in userProperties, subscribes to that topic and blocks until the agent replies.

```bash
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait \
  --agent openclaw-doc --task status --timeout 30
```

The agent receives the task with:
- **userProperties**: `name`, `description`, `emoji`, `reply_to=agent-reply/<id>`
- Agent should publish its response to the `reply_to` topic in userProperties

### Fire & Forget

```bash
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send \
  --agent openclaw-doc --msg "请检查系统状态"

node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send \
  --agent openclaw-doc --task health
```

### Custom tasks with parameters

```bash
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait \
  --agent openclaw-doc --task custom \
  --params '{"action": "report", "level": "full"}' \
  --timeout 30
```

### Identity customization

```bash
# Override sender identity per-command
node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send \
  --agent openclaw-doc --msg "hello" \
  --sender-name "马龙 🛠️" --sender-emoji "🛠️" --sender-desc "开发管理"
```

---

## 3. Cross-Channel Reply Routing (QQ Bot ←→ MQTT)

The core pattern for routing MQTT agent replies back to QQ Bot:

```
# Step 1: Send task with send-wait, get the reply JSON
reply_json = exec("""
  node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait \\
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

```
# 1. User asks in QQ Bot: "看看 openclaw-doc 的状态"

# 2. Send task and wait for reply via MQTT
reply = exec("node skills/emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait --agent openclaw-doc --task status --timeout 15")

# 3. Check if we got a reply
if "No reply received" in reply:
    message(channel="qqbot", ..., message="openclaw-doc 没有响应")
else:
    message(channel="qqbot", ..., message=reply)
```

---

## MQTT v5 Protocol & Message Format (mqtt-chat compatible)

The scripts follow the **mqtt-chat app conventions** exactly for full interoperability.

### Wire Protocol

- **MQTT version**: v5
- **MQTT.js client**: `import mqtt from "mqtt"`
- **Topic**: `{targetClientId}/inbound` (private messages, push-to-inbox model)
- **Inbox subscription**: `{ownClientId}/inbound` (each agent subscribes to its own inbox)
- **userProperties**: Sender identity & reply routing

### userProperties (MQTT v5 header)

Every PUBLISH packet carries:

```
name:        马龙 🛠️        (sender display name)
emoji:       🛠️              (sender avatar)
description: 开发管理          (sender role/tagline)
reply_to:    openclaw-malong/inbound   (where to send replies)
```

The receiver discovers the sender's identity from userProperties — no separate registration needed.

### Message Body (JSON)

```json
{
  "id": "a1b2c3d4e5f6",
  "text": "请汇报当前状态",
  "senderId": "openclaw-malong",
  "timestamp": "2026-05-24T21:22:00.000Z",
  "type": "text"
}
```

Task messages are plain text — no extra fields. The receiving agent reads `text` and responds accordingly.

### Private Chat Flow (mqtt-chat convention)

```
Sender (openclaw-malong)               EMQX Broker                  Recipient (agent-001)
       |                                    |                              |
       | PUBLISH to "agent-001/inbound":    |                              |
       | {                                  |                              |
       |   id:"abc", text:"Hello",         |                              |
       |   senderId:"openclaw-malong",     |                              |
       |   timestamp:..., type:"text"      |                              |
       | }                                  |                              |
       | userProperties:                    |                              |
       |  {name:"马龙", emoji:"🛠️",        |                              |
       |   reply_to:"openclaw-malong/inbound"}  →   delivers to inbox →  |
       |                                    |                              |
       |  ←  agent-001 replies to          |  PUBLISH to                  |
       |      "openclaw-malong/inbound"    ←  "openclaw-malong/inbound"  |
       |      with own userProperties      |                              |
```

---

## Scripts Reference

| Script | Commands | Purpose |
|--------|----------|---------|
| `emqx_list_clients.mjs` | — | Discover agents, watch presence, list endpoints |
| `emqx_agent_communicate.mjs` | `discover` | List agents with inbound topic details |
| | `subs <clientid>` | Check agent subscriptions |
| | `send --agent <id>` | Fire-and-forget message/task |
| | `send-wait --agent <id>` | Send task + wait for reply (blocking) |
| | `listen` | Listen on own inbox for debugging |

---

## Agent Communication Convention

| Direction | Topic Pattern | Example |
|-----------|---------------|---------|
| Inbound (receive) | `{clientid}/inbound` | `openclaw-doc/inbound` |
| Outbound (send) | `{targetClientId}/inbound` | `openclaw-malong/inbound` |
| Reply (send-wait) | `agent-reply/{uuid}` | `agent-reply/a1b2c3d4e5f6` |
| Group chat | `group_{name}/bound` | `group_dev/bound` |

---

## Task Types

Tasks are plain text messages. Each task template maps to a human-readable text:

| Task | Text Content |
|------|-------------|
| `ping` | `ping` |
| `status` | `请汇报当前状态` |
| `health` | `请检查系统健康状态 (CPU/内存/磁盘/运行时间)` |
| `inventory` | `请列出可用资源清单` |
| `custom` | User-specified (via `--msg` or `--params`) |

Custom tasks:
```bash
# Direct message
node emqx_agent_communicate.mjs send --agent openclaw-doc --msg "写一份mqtt报告"

# Via --params
node emqx_agent_communicate.mjs send --agent openclaw-doc --task custom \
  --params '{"text": "写一份mqtt报告"}'

# With send-wait
node emqx_agent_communicate.mjs send-wait --agent openclaw-doc --task custom \
  --params '{"text": "写一份mqtt报告"}' --timeout 60
```

