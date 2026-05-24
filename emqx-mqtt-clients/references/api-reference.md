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

```python
message(action="send", channel="mqtt", target="group:{topic}", message="...")
```

Parameters:
- `channel` — `"mqtt"`
- `target` — `"group:{topic}"` for group/broadcast, or `"{clientId}"` for private
- `message` — text content

---

## MQTT v5 Protocol Details

### Connection
- Protocol: MQTT v5
- Port: 1883 (TCP) / 8083 (WebSocket)
- Client ID: Unique per agent
- No auth by default (configurable in EMQX)

### Publish Properties (userProperties)

MQTT v5 user properties carry sender metadata:
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

Reply routing is userProperties-only. The body does not carry `reply_to`.

### mqtt-chat Compatibility

Messages sent by this script are fully compatible with the MQTT Chat app:
- Same JSON structure (`id`, `text`, `senderId`, `timestamp`, `type`)
- Same userProperties (`name`, `emoji`, `description`, `reply_to`)
- Same topic conventions (`{clientId}/inbound`)
- Same MQTT v5 protocol

---

## Agent Communication Convention (MQTT v5)

This follows the mqtt-chat app conventions.

### Topic Patterns

| Direction | Topic Pattern | Example |
|-----------|---------------|---------|
| Inbound (receive) | `{clientid}/inbound` | `openclaw-doc/inbound` |
| Group chat | `group_{name}/bound` | `group_dev/bound` |
| Reply (response) | Dynamic via `reply_to` | `openclaw-malong/inbound` |

### MQTT v5 userProperties

Every publish carries sender identity in user properties:

```
name:         Display name
emoji:        Avatar emoji
description:  Role/tagline
reply_to:     {senderId}/inbound  (reply routing)
```

### Message JSON Format

```json
{
  "id": "<uuid>",
  "text": "message text",
  "senderId": "<client-id>",
  "timestamp": "<ISO-8601>",
  "type": "text|file",
  "<extra_fields>": {}
}
```

---

## Task Payload Formats

### Built-in Task Types

| Task | Action | Description |
|------|--------|-------------|
| `ping` | ping | Connectivity test |
| `status` | status_report | Request status report |
| `health` | health_check | Health check (CPU, memory, disk, uptime) |
| `inventory` | inventory | Inventory report |
| `custom` | custom | User-defined task |

Generic JSON structure (extends the chat message format):
```json
{
  "id": "a1b2c3d4e5f6",
  "text": "Request agent status report",
  "senderId": "openclaw-malong",
  "timestamp": "...",
  "type": "text",
  "kind": "task",
  "action": "<action_name>",
  "task_name": "<task_type>",
  "description": "<human_description>",
  "payload": { }
}
```

Extra fields (`kind`, `action`, `task_name`, `payload`) are embedded in the chat message format for compatibility.

Reply routing is handled exclusively via MQTT v5 userProperties `reply_to`, not in the message body.

---

## Error Codes

| Code | Meaning |
|------|---------|
| 401 | BAD_API_KEY_OR_SECRET — wrong API key |
| 404 | Resource not found |
| 500 | Internal server error |
