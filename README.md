# @turquoisebay/mqtt

[![CI](https://github.com/hughmadden/openclaw-mqtt/actions/workflows/ci.yml/badge.svg)](https://github.com/hughmadden/openclaw-mqtt/actions)
[![npm](https://img.shields.io/npm/v/@turquoisebay/mqtt)](https://www.npmjs.com/package/@turquoisebay/mqtt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MQTT channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — bidirectional messaging via MQTT brokers with support for private chat, group chat, and file sharing.

## Features

- 💬 **Private & Group Chat** — direct messages and group conversations via MQTT topics
- 📁 **File Sharing** — send and receive files via base64-encoded MQTT messages (up to 10MB)
- 🔌 **Bidirectional messaging** — subscribe and publish to MQTT topics
- 🔁 **Robust reconnection** — exponential backoff with jitter, recovers from broker restarts
- 🔒 **TLS support** — secure connections to cloud brokers
- ⚡ **QoS levels** — configurable delivery guarantees (0, 1, 2)
- 🎯 **Targeted Messaging** — @-mention specific clients via `targetIds` array

## Installation

```bash
openclaw plugins install @turquoisebay/mqtt
```

Or manually:

```bash
git clone https://github.com/hughmadden/openclaw-mqtt ~/.openclaw/extensions/mqtt
cd ~/.openclaw/extensions/mqtt && npm install
```

## Configuration

Add to `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    mqtt: {
      brokerUrl: "mqtt://localhost:1883",
      // Authentication
      username: "openclaw",
      password: "secret",
      // Client ID (used as senderId in all messages)
      clientId: "openclaw-agent",
      // MQTT v5.0 is required (user properties for reply_to)
      protocolVersion: 5,
      // User properties sent with every message
      userProperties: {
        name: "OpenClaw Agent",
        emoji: "🤖"
      },
      // Topics
      topics: {
        inbound: "openclaw/inbound",   // Topic subscribed for incoming messages
      },
      // Quality of Service (0=fire-and-forget, 1=at-least-once, 2=exactly-once)
      qos: 1
    }
  }
}
```

Then restart the gateway:

```bash
openclaw gateway restart
```

### Environment Variables

Sensitive configuration can be set via environment variables:

| Variable | Description |
|----------|-------------|
| `MQTT_BROKER_URL` | MQTT broker URL |
| `MQTT_USERNAME` | Broker username |
| `MQTT_PASSWORD` | Broker password |
| `MQTT_CLIENT_ID` | Client ID (used as senderId) |
| `MQTT_USER_PROPERTIES` | JSON string of user properties |
| `MQTT_FILES_DIR` | Directory for saving incoming files (default: `{workspaceDir}/received_files/`) |

Environment variables take precedence over values in openclaw.json.

## Message Protocol

### Message Format (JSON)

All messages are JSON with the following structure:

```json
{
  "id": "mqtt-1712345678901-abc123",
  "senderId": "client-device-1",
  "text": "message content",
  "timestamp": "2026-05-15T12:00:00.000Z",
  "type": "text",
  "targetIds": ["clientA", "clientB"],
  "fileName": "report.pdf",
  "fileType": "application/pdf",
  "fileData": "base64-encoded-content"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `senderId` | Yes | Unique identifier of the sender |
| `text` | Yes | Message body text |
| `id` | Auto | Unique message ID (`mqtt-{timestamp}-{random}`) |
| `timestamp` | Auto | ISO timestamp of the message |
| `type` | No | `"text"` (default) or `"file"` |
| `targetIds` | No | Array of target client IDs for @-mention / directed messages |
| `fileName` | No | File name (when `type: "file"`) |
| `fileType` | No | MIME type (when `type: "file"`) |
| `fileData` | No | Base64-encoded file content (when `type: "file"`) |

### Reply Mechanism (MQTT v5.0 User Properties)

Every inbound message **must** include a `reply_to` property in MQTT v5.0 userProperties. The agent publishes replies to the topic specified by `reply_to`.

```bash
mosquitto_pub \
  --property "user-property" "reply_to=openclaw/reply/my-device" \
  -t "openclaw/inbound" \
  -m '{"senderId":"my-device","text":"hello"}'
```

If no `reply_to` is provided, replies default to `openclaw/outbound`.

## Chat Types

### Private Chat

Every client that sends a message to the inbound topic registers its `reply_to` topic. The agent stores a mapping of `senderId → replyTopic`.

```
Device A ──► openclaw/inbound ──► Agent
              (reply_to: device-a/replies)
Agent   ──► device-a/replies   ──► Device A
```

### Group Chat

Group conversations use a separate MQTT topic shared among all members.

**Joining a group:**

Send a control message with `kind: "invite"` to `openclaw/inbound`:

```json
{
  "senderId": "group-admin",
  "text": "join group",
  "kind": "invite",
  "topic": "openclaw/groups/room1"
}
```

The agent will:
1. Subscribe to `openclaw/groups/room1`
2. Publish a `kind: "accept"` confirmation to the group topic
3. Process all subsequent messages on that topic as group messages

**Leaving a group:**

Send a control message with `kind: "dismissed"`:

```json
{
  "senderId": "group-admin",
  "text": "leave",
  "kind": "dismissed",
  "topic": "openclaw/groups/room1"
}
```

The agent will:
1. Publish a `kind: "bye"` notification
2. Unsubscribe from the group topic
3. Clean up all member state

**Group message flow:**

```
Device A ──► openclaw/groups/room1 ──► Agent
Device B ──► openclaw/groups/room1 ──► Agent
Agent    ──► openclaw/groups/room1 ──► Device A, Device B (broadcast)
```

Group replies are broadcast to all members. To direct a reply to specific members, use `targetIds`.

### Targeted Messages (@-mentions)

To @-mention a specific client, include their client ID in the `targetIds` array:

```json
{
  "senderId": "device-a",
  "text": "hello",
  "targetIds": ["openclaw-agent"]
}
```

The agent will:
- Only reply if its own clientId is in `targetIds`
- When replying in a group, prepend `@senderName` and include `targetIds: [senderId]`
- If message has `targetIds` not meant for the agent, it records context without replying

## Tools

### mqtt_send (Agent Tool)

When the plugin is installed, the `mqtt_send` tool is automatically registered in OpenClaw's TOOLS. The agent can use it to proactively send messages.

**Parameters:**

| Parameter | Required | Description |
|-----------|----------|-------------|
| `text` | Yes | Message text content |
| `targetClientId` | No* | Target client ID for private chat (looks up client's registered reply topic) |
| `conversationLabel` | No* | Pass the ConversationLabel from your context directly (recommended) |
| `targetIds` | No | Array of target client IDs for @-mention |
| `targetNames` | No | Array of display names for @-mention (auto-resolved to client IDs) |
| `qos` | No | QoS level (0, 1, 2), defaults to 1 |

*\*Either `targetClientId` or `conversationLabel` must be provided, but not both.*

**Sending Rules:**

| Trigger Scenario | Send Target | Behavior |
|-----------------|-------------|----------|
| Group message triggered | Use `conversationLabel` from context | Prepend `@{senderName}` to text, set `targetIds` to specify recipients |
| Private chat triggered | Use `targetClientId` to look up registered `reply_to` topic | Error if target client has not registered a topic |
| Group directed message | Group topic with `targetIds` | Send in the group with `targetIds` for @-mention, not via private topic |
| Group file sharing | Group topic | Send file as a group message (`type: "file"`), not via private message |

**Examples:**

```json5
// Group broadcast (use conversationLabel from context)
{ "text": "Hello everyone", "conversationLabel": "mqtt:group:openclaw/groups/room1" }

// Group directed message
{ "text": "@device-a please check", "conversationLabel": "mqtt:group:openclaw/groups/room1", "targetIds": ["device-a"] }

// Group with display name targeting
{ "text": "@测试管理 请回复", "conversationLabel": "mqtt:group:openclaw/groups/room1", "targetNames": ["测试管理"] }

// Private chat (auto-resolves topic)
{ "text": "Hello privately", "targetClientId": "device-a" }
```

## File Sharing

### Receiving Files

When a message has `type: "file"`, the agent **first saves the file to disk**, then passes the local file path to the agent for processing:

```json
{
  "senderId": "sensor-1",
  "text": "screenshot",
  "type": "file",
  "fileName": "capture.png",
  "fileType": "image/png",
  "fileData": "iVBORw0KGgo..."
}
```

**Flow:**
1. Decode base64 `fileData` to binary
2. Save to disk: `~/.openclaw/mqtt-files/{timestamp}-{random}-{fileName}`
3. Pass file path to agent via `Media` field (not base64 data)
4. Agent reads file from disk as needed

**File receive directory:**
- Default: `{workspaceDir}/received_files/` (under the OpenClaw workspace directory)
- Override: `MQTT_FILES_DIR` environment variable
- File naming: `{timestamp}-{random}-{originalFileName}` (avoids collisions)
- Max size: 10MB (same as outbound limit)

If saving fails, falls back to `data:` URL.

### Sending Files

The agent can send files via the standard `outbound.sendMedia` path. Supported input formats:

| Format | Example |
|--------|---------|
| `data:` URL | `data:image/png;base64,iVBOR...` |
| `file://` URL | `file:///path/to/file.pdf` |
| Absolute path | `/path/to/file.pdf` |
| Raw base64 | `iVBORw0KGgo...` |

File size limit: **10MB**. Larger files are rejected.

## Security

## EMQX MQTT Clients Skill

项目内置 `emqx-mqtt-clients/` 技能，用于在运行时发现和管理接入 EMQX broker 的其他 MQTT agent，遵循 [mqtt-chat](https://github.com/anomalyco/mqtt-chat) 的私聊协议。

### 概述

| 脚本 | 功能 |
|------|------|
| `emqx_list_clients.mjs` | 发现 agent、监控上下线、查看连接端点 |
| `emqx_agent_communicate.mjs` | 发送消息/任务、等待回复、监听 inbox |

底层使用 **MQTT.js v5** 实现，消息格式与 mqtt-chat 完全兼容。

### Wire Protocol

```
每个 agent 订阅: {ownClientId}/inbound
发送私聊消息:    publish to {targetClientId}/inbound
回复路由:        MQTT v5 userProperties.reply_to
```

发送时携带的 userProperties：
```
name:        Display name
emoji:       Avatar emoji  
description: Role
reply_to:    {senderId}/inbound
```

消息体为纯 JSON：
```json
{"id":"...", "text":"message", "senderId":"...", "timestamp":"...", "type":"text"}
```

### 配置

**方式一：export 环境变量**

```bash
# EMQX 连接
export EMQX_HOST="192.168.106.121"
export EMQX_MQTT_PORT="1883"
export EMQX_API_PORT="18083"
export EMQX_API_KEY="<api-key-id>"
export EMQX_API_SECRET="<api-secret-key>"

# Agent 身份
export EMQX_SENDER_ID="openclaw-malong"
export EMQX_SENDER_NAME="马龙 🛠️"
export EMQX_SENDER_EMOJI="🛠️"
export EMQX_SENDER_DESC="开发管理"

# MQTT 认证（可选）
export EMQX_MQTT_USERNAME=""
export EMQX_MQTT_PASSWORD=""
```

**方式二：`.env` 文件**

创建 `~/.openclaw/workspace/.env`：

```
# EMQX 连接
EMQX_HOST=192.168.106.121
EMQX_MQTT_PORT=1883
EMQX_API_PORT=18083
EMQX_API_KEY=<api-key-id>
EMQX_API_SECRET=<api-secret-key>

# Agent 身份
EMQX_SENDER_ID=openclaw-malong
EMQX_SENDER_NAME=马龙 🛠️
EMQX_SENDER_EMOJI=🛠️
EMQX_SENDER_DESC=开发管理

# MQTT 认证（可选）
EMQX_MQTT_USERNAME=
EMQX_MQTT_PASSWORD=
```

**方式三：交互式向导**

```bash
bash emqx-mqtt-clients/scripts/setup.sh
```

### 使用

**发现 agent：**
```bash
# 列出所有在线 agent
node emqx-mqtt-clients/scripts/emqx_list_clients.mjs

# 带 inbound topic 信息
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs discover --filter "openclaw-"

# 查看 agent 订阅
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs subs openclaw-doc

# 监控上下线
node emqx-mqtt-clients/scripts/emqx_list_clients.mjs --watch
```

**任务分派：**
```bash
# 发送消息（fire-and-forget）
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send \
  --agent openclaw-doc --msg "请汇报状态"

# 发送并等待回复（阻塞）
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait \
  --agent openclaw-doc --task status --timeout 30

# 自定义任务
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs send-wait \
  --agent openclaw-doc --task custom \
  --params '{"text": "写一份mqtt报告"}' --timeout 60
```

**调试监听：**
```bash
node emqx-mqtt-clients/scripts/emqx_agent_communicate.mjs listen
```

### 任务类型

| 任务 | 文本内容 |
|------|---------|
| `ping` | `ping` |
| `status` | `请汇报当前状态` |
| `health` | `请检查系统健康状态 (CPU/内存/磁盘/运行时间)` |
| `inventory` | `请列出可用资源清单` |
| `custom` | 用户自定义（通过 `--msg` 或 `--params`） |

### 跨渠道场景

```
QQ Bot 用户 ──→ agent ──→ send-wait → MQTT agent
                                        ↓
agent ←── 回复 ────────────────── MQTT agent
   ↓
QQ Bot 用户 ←── forward
```

发送时用 `send-wait`，收到回复后通过 `message(channel="qqbot", ...)` 转发。

---

## Security

**Important:** Any client that can publish to the inbound topic has full access to your OpenClaw agent. Treat MQTT as a **trusted channel only** (restricted broker, auth, private network).

Key security considerations:
- Use username/password or certificate authentication on the broker
- Restrict network access to the MQTT broker
- All clients should use unique `clientId` values
- The plugin ignores its own messages (detected by matching `senderId` with configured `clientId`)

## Architecture

```
MQTT Broker (Mosquitto/EMQX)
     │
     ├─► openclaw/inbound ───────────► Agent (private messages)
     │                                    │
     ├─► openclaw/groups/room1 ────────► Agent (group messages)
     │                                    │
     └─◄ {reply_to topic} ◄────────────── Agent (private replies)
     └─◄ openclaw/groups/room1 ◄───────── Agent (group broadcasts)
```

The reply topic is determined by the `reply_to` user property in the incoming MQTT v5.0 packet.

## Development

```bash
# Clone
git clone ssh://<host>/opt/git/openclaw-mqtt.git
cd openclaw-mqtt

# Install deps
npm install

# Run tests
npm test

# Type check
npm run typecheck

# Build
npm run build
```

## License

MIT © Hugh Madden

## See Also

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI assistant platform
- [MQTT.js](https://github.com/mqttjs/MQTT.js) — MQTT client library
- [Mosquitto](https://mosquitto.org/) — Popular MQTT broker
