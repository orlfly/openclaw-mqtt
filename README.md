# @turquoisebay/mqtt

[![CI](https://github.com/hughmadden/openclaw-mqtt/actions/workflows/ci.yml/badge.svg)](https://github.com/hughmadden/openclaw-mqtt/actions)
[![npm](https://img.shields.io/npm/v/@turquoisebay/mqtt)](https://www.npmjs.com/package/@turquoisebay/mqtt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

MQTT channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — bidirectional messaging via MQTT brokers.

## Features

- 🔌 **Bidirectional messaging** — subscribe and publish to MQTT topics
- 🔁 **Robust reconnection** — recovers from broker restarts and cold starts
- 🔒 **TLS support** — secure connections to cloud brokers
- ⚡ **QoS levels** — configurable delivery guarantees (0, 1, 2)

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
      // Optional auth
      username: "openclaw",
      password: "secret",
      // MQTT v5.0 specific options
      protocolVersion: 5,              // Only supports MQTT 5.0
      userProperties: {                // Custom properties sent with connection
        "application": "openclaw-mqtt",
        "version": "1.0.0"
      },
      // Topics
      topics: {
        inbound: "openclaw/inbound",   // Subscribe to this
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

## Usage

### Sessions & correlation IDs (important)

- **Sessions are keyed by `senderId`** → OpenClaw uses `mqtt:{senderId}` as the SessionKey, so memory and conversation history are grouped by sender.
- **`correlationId` is request‑level only** → if you include it in inbound JSON, it's echoed back in the outbound reply for client-side matching. It does **not** create a new session or change memory.

If you want separate conversations, use distinct `senderId`s.

### Receiving messages (inbound)

Messages published to your `inbound` topic will be processed by OpenClaw.
With MQTT v5.0, you must include a `reply_to` property in the userProperties to specify the reply topic.
You can send either plain text or JSON (recommended):

```bash
# Plain text with user properties (using mosquitto_pub with MQTT v5.0)
mosquitto_pub --property "user-property" "reply_to=openclaw/reply/pg-cli" -t "openclaw/inbound" -m "Alert: Service down on playground"

# JSON (recommended) with user properties
mosquitto_pub --property "user-property" "reply_to=openclaw/reply/pg-cli" -t "openclaw/inbound" -m '{"senderId":"pg-cli","text":"hello","correlationId":"abc-123"}'
```

### Message Reply Mechanism

The MQTT plugin uses a dynamic reply mechanism based on MQTT v5.0 userProperties:

- **Reply Topic Selection**: The topic for sending replies is determined by the `reply_to` userProperty in the incoming message. 
- **Fallback Behavior**: If no `reply_to` property is provided, replies will go to the default `openclaw/outbound` topic.
- **Message Format**: All agent replies are published as JSON with the following structure:

```json
{"senderId":"openclaw","text":"...","kind":"final","ts":1700000000000}
```

This dynamic reply mechanism allows publishers to control where responses are delivered, enabling flexible communication patterns between multiple services.

If you want to publish custom text via CLI, use the `message` tool:

```bash
openclaw agent --message "Send MQTT: Temperature is 23°C"
```

## Security

**Important:** Any client that can publish to the inbound topic has full access to your OpenClaw agent. Treat MQTT as a **trusted channel only** (restricted broker, auth, private network). If you need untrusted access, add a validation layer before publishing to `openclaw/inbound`.

## Development

```bash
# Clone (replace with your host)
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

## Architecture

```
MQTT Broker (Mosquitto/EMQX)
     │
     ├─► inbound topic ──► OpenClaw Gateway ──► Agent
     │
     └─◄ dynamic reply topic (via reply_to user property) ◄── OpenClaw Gateway ◄── Agent
```

The reply topic is determined dynamically based on the `reply_to` user property in the incoming message.
If no `reply_to` property is provided, replies default to `openclaw/outbound`.

## License

MIT © Hugh Madden

## See Also

- [OpenClaw](https://github.com/openclaw/openclaw) — The AI assistant platform
- [MQTT.js](https://github.com/mqttjs/MQTT.js) — MQTT client library
- [Mosquitto](https://mosquitto.org/) — Popular MQTT broker
