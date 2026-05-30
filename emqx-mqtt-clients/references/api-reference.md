# EMQX API Reference

## Clients API

### `GET /api/v5/clients`
List connected/disconnected clients. See SKILL.md for usage.

### `GET /api/v5/clients/{clientid}`
Get details of a specific client.

### `DELETE /api/v5/clients/{clientid}`
Kick (disconnect) a client. Requires administrator role.

### `GET /api/v5/clients/{clientid}/subscriptions`
List a client's subscribed topics.

### `GET /api/v5/nodes`
List EMQX cluster nodes.

---

## MQTT Publish API

### `POST /api/v5/publish`
Publish an MQTT message programmatically.

**Request Body:**
```json
{
  "topic": "openclaw-doc/inbound",
  "payload": "hello agent",
  "qos": 1,
  "retain": false,
  "encoding": "plain",
  "content_type": "text/plain"
}
```

**Response:**
```json
{"id": "0006528F1BA3149BF7A706006FAB0000"}
```

---

## Cross-Channel Messaging (OpenClaw Tools)

### `mqtt_send` — MQTT Native

Send messages to MQTT agent topics. Preferred for MQTT-to-MQTT.

```
Format:  mqtt:group:{topic}     for group/broadcast topics
         mqtt:{senderId}        for private reply topics

Example: mqtt:group:openclaw-doc/inbound
```

Parameters:
- `text` — message content
- `conversationLabel` — `mqtt:group:{topic}` for agent inbound
- `targetNames` — array of display names for @-mentions
- `qos` — 0, 1, or 2 (default 1)

### `message` (channel="mqtt") — Cross-Channel

Send MQTT messages from any incoming channel (QQ Bot, WebChat, etc.).

```
message(action="send", channel="mqtt", target="group:{topic}", message="...")
```

Parameters:
- `channel` — `"mqtt"`
- `target` — `"group:{topic}"` for group/broadcast, or `"{clientId}"` for private
- `message` — text content

---

## MQTT v5 Protocol Details

### Connection (MQTT.js)
- Library: `mqtt` (npm package)
- Protocol: MQTT v5
- Port: 1883 (TCP)
- Client ID: Unique per agent (auto-generated with prefix)
- No auth by default (configurable in EMQX)

### Publish Properties (userProperties)

MQTT v5 user properties carry sender metadata — this is the agent identity/registration mechanism from mqtt-chat:

```
name:        Display name (e.g. "马龙 🛠️")
emoji:       Avatar emoji (e.g. "🛠️")
description: Role description (e.g. "开发管理")
reply_to:    Where to send replies (e.g. "openclaw-malong/inbound")
```

### Properties vs Message Body

| Layer | Carries |
|-------|---------|
| MQTT v5 userProperties | Sender identity, reply routing |
| JSON body payload | Message content, task details |

Reply routing is in userProperties. The body does not carry `reply_to`.

### mqtt-chat Compatibility

Messages sent by the scripts are fully compatible with the MQTT Chat app:
- Same JSON structure (`id`, `text`, `senderId`, `timestamp`, `type`)
- Same userProperties (`name`, `emoji`, `description`, `reply_to`)
- Same topic conventions (`{clientId}/inbound`)
- Same MQTT v5 protocol
- Same push-to-inbox model

---

## Agent Communication Convention (MQTT v5 / mqtt-chat)

This follows the mqtt-chat app conventions exactly.

### Topic Patterns

| Direction | Topic Pattern | Example |
|-----------|---------------|---------|
| Inbound (receive) | `{clientid}/inbound` | `openclaw-doc/inbound` |
| Outbound (send) | `{target}/inbound` | `openclaw-malong/inbound` |
| Group chat | `group_{name}/bound` | `group_dev/bound` |
| Reply (send-wait) | `agent-reply/{uuid}` | `agent-reply/a1b2c3` |

### MQTT v5 userProperties

Every publish carries sender identity in user properties:

```
name:         Display name
emoji:        Avatar emoji
description:  Role/tagline
reply_to:     Reply routing address
```

### Message JSON Format

```json
{
  "id": "<uuid-short>",
  "text": "message text",
  "senderId": "<client-id>",
  "timestamp": "<ISO-8601>",
  "type": "text|file",
  "<extra_fields>": {}
}
```

### Private Chat Flow

1. Each agent subscribes to `{ownClientId}/inbound`
2. To send a private message, publish to `{targetClientId}/inbound`
3. Include `{name, emoji, description, reply_to}` in MQTT v5 userProperties
4. Recipient discovers sender identity from userProperties in the received packet
5. Recipient replies by publishing to the `reply_to` address

---

## Task Types

Tasks are sent as plain `text` messages. The text content carries all semantics:

| Task | Text sent |
|------|-----------|
| `ping` | `ping` |
| `status` | `请汇报当前状态` |
| `health` | `请检查系统健康状态 (CPU/内存/磁盘/运行时间)` |
| `inventory` | `请列出可用资源清单` |
| `custom` | User-defined message (via `--msg` or `--params`) |

Custom tasks with `--params '{"text": "写一份mqtt报告"}'` produce:
```json
{
  "id": "a1b2c3d4e5f6",
  "text": "写一份mqtt报告",
  "senderId": "openclaw-malong",
  "timestamp": "2026-05-24T21:22:00.000Z",
  "type": "text"
}
```

---

## Error Codes

| Code | Meaning |
|------|---------|
| 401 | BAD_API_KEY_OR_SECRET — wrong API key |
| 404 | Resource not found |
| 500 | Internal server error |
