#!/usr/bin/env node
/**
 * EMQX Agent Communication Tool (MQTT.js)
 *
 * Follows the mqtt-chat app conventions exactly:
 *   - MQTT v5 with userProperties for sender identity
 *   - Message JSON: {id, text, senderId, timestamp, type}
 *   - Private messages: publish to {targetClientId}/inbound
 *   - Inbox subscription: {ownClientId}/inbound
 *   - Reply routing via userProperty reply_to = {senderId}/inbound
 *
 * Commands:
 *   discover          List agents with inbound topic details (HTTP API)
 *   subs <clientid>   Show agent subscriptions (HTTP API)
 *   send              Send message via MQTT v5 (fire and forget)
 *   send-wait         Send message + wait for reply (blocking with timeout)
 *   listen            Listen on {senderId}/inbound for incoming messages
 *
 * Usage:
 *   node emqx_agent_communicate.mjs discover
 *   node emqx_agent_communicate.mjs discover --filter "openclaw-"
 *   node emqx_agent_communicate.mjs subs openclaw-doc
 *   node emqx_agent_communicate.mjs send --agent openclaw-doc --msg "Hello"
 *   node emqx_agent_communicate.mjs send-wait --agent openclaw-doc --msg "汇报状态" --timeout 60 --idle-timeout 10
 *   node emqx_agent_communicate.mjs listen
 *
 * Environment:
 *   EMQX_HOST              EMQX broker host
 *   EMQX_MQTT_PORT         MQTT port (default: 1883)
 *   EMQX_API_PORT          API port (default: 18083)
 *   EMQX_API_KEY           API key ID
 *   EMQX_API_SECRET        API key secret
 *   EMQX_SENDER_ID         Agent client ID (e.g. openclaw-malong)
 *   EMQX_SENDER_NAME       Display name (e.g. 马龙 🛠️)
 *   EMQX_SENDER_EMOJI      Avatar emoji (e.g. 🛠️)
 *   EMQX_SENDER_DESC       Description/role (e.g. 开发管理)
 */

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

// ── Configuration ──────────────────────────────────────────────────────

const DEFAULT_SENDER_ID   = process.env.EMQX_SENDER_ID   || "openclaw-main";
const DEFAULT_SENDER_NAME = process.env.EMQX_SENDER_NAME || "OpenClaw Agent";
const DEFAULT_SENDER_EMOJI = process.env.EMQX_SENDER_EMOJI || "🤖";
const DEFAULT_SENDER_DESC = process.env.EMQX_SENDER_DESC || "MQTT Agent";

// ── Helpers ────────────────────────────────────────────────────────────

function getEnv(key) {
  return process.env[key] || "";
}

function getEnvOrRaise(key) {
  const val = getEnv(key);
  if (!val) {
    console.error(`Error: ${key} not set.`);
    process.exit(1);
  }
  return val;
}

function shortId(length = 12) {
  return randomBytes(length).toString("hex").slice(0, length);
}

function isoNow() {
  return new Date().toISOString();
}

function buildAuthHeader(apiKey, apiSecret) {
  return `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
}

// ── HTTP helpers ───────────────────────────────────────────────────────

async function emqxGet(path, host, port, apiKey, apiSecret, params) {
  const protocol = port === 443 ? "https" : "http";
  let url = `${protocol}://${host}:${port}/api/v5${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) url += `?${qs}`;
  }

  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: buildAuthHeader(apiKey, apiSecret),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body}`);
    process.exit(1);
  }
  return res.json();
}

async function fetchClients(host, port, apiKey, apiSecret, limit = 1000, like) {
  return emqxGet("/clients", host, port, apiKey, apiSecret, { page: 1, limit, like });
}

async function getSubscriptions(host, port, apiKey, apiSecret, clientid) {
  return emqxGet(`/clients/${clientid}/subscriptions`, host, port, apiKey, apiSecret);
}

// ── Message format (mqtt-chat compatible) ──────────────────────────────

/**
 * Build a JSON message following mqtt-chat convention.
 * Format: { id, text, senderId, timestamp, type }
 */
function buildMessage(text, senderId, msgType = "text") {
  return JSON.stringify({
    id: shortId(12),
    text,
    senderId,
    timestamp: isoNow(),
    type: msgType,
  });
}

function resolveInboundTopic(agentId) {
  return `${agentId}/inbound`;
}

// ── MQTT helpers ───────────────────────────────────────────────────────

async function loadMqtt() {
  // Node.js resolves "mqtt" from node_modules/ in cwd and all parent dirs.
  // If the script is run from the project root (where mqtt is installed),
  // or from a workspace with a hoisted node_modules, this works directly.
  try {
    return await import("mqtt");
  } catch {
    // Fallback: try to load from the skill's plugin project root
    const { fileURLToPath } = await import("node:url");
    const pathMod = await import("node:path");
    const scriptDir = pathMod.dirname(fileURLToPath(import.meta.url));
    const projectRoot = pathMod.join(scriptDir, "..", "..");  // scripts/ -> emqx-mqtt-clients/ -> project/
    try {
      return await import(pathMod.join(projectRoot, "node_modules", "mqtt", "dist", "mqtt.js"));
    } catch {
      console.error("Failed to load mqtt module.");
      console.error("Ensure mqtt is installed in the project root.");
      console.error("Alternative: set NODE_PATH to the project's node_modules.");
      process.exit(1);
    }
  }
}

/**
 * Create and connect an MQTT v5 client.
 */
async function createMqttClient(host, port, timeout = 15) {
  const mqtt = await loadMqtt();
  const opts = {
    protocolVersion: 5,
    clientId: `${DEFAULT_SENDER_ID}-${shortId(6)}`,
    clean: true,
    connectTimeout: (timeout + 5) * 1000,
    reconnectPeriod: 0,
  };
  if (process.env.EMQX_MQTT_USERNAME) {
    opts.username = process.env.EMQX_MQTT_USERNAME;
    opts.password = process.env.EMQX_MQTT_PASSWORD;
  }
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${host}:${port}`, opts);

    const timer = setTimeout(() => {
      client.end();
      reject(new Error(`Connect timeout (${timeout}s) to ${host}:${port}`));
    }, timeout * 1000);

    client.on("connect", () => {
      clearTimeout(timer);
      resolve(client);
    });

    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Build MQTT v5 publish userProperties matching mqtt-chat convention.
 *
 * Every publish carries:
 *   name, description, emoji — sender identity
 *   reply_to                  — where the recipient should reply
 */
function buildUserProperties(senderId, senderName, senderEmoji, senderDesc, replyTo) {
  const up = {
    name: senderName,
    description: senderDesc,
    emoji: senderEmoji,
  };
  if (replyTo) {
    up.reply_to = replyTo;
  }
  return up;
}

// ── Commands ───────────────────────────────────────────────────────────

/**
 * discover — List agents via HTTP API with inbound topic info.
 */
async function cmdDiscover(args) {
  const host      = args.host;
  const port      = args.port;
  const apiKey    = args.apiKey;
  const apiSecret = args.apiSecret;

  const resp    = await fetchClients(host, port, apiKey, apiSecret, 1000, args.filter);
  const clients = resp.data || [];

  if (!clients.length) {
    console.log("No agents found.");
    return;
  }

  console.log(`Discovered ${clients.length} agent(s):\n`);
  for (const c of clients) {
    const cid       = c.clientid || "?";
    const user      = c.username || "?";
    const ip        = c.ip_address || "?";
    const connected = !!c.connected;
    const subs      = c.subscriptions_cnt || 0;
    const status    = connected ? "🟢" : "🔴";
    const inbound   = resolveInboundTopic(cid);

    console.log(`  ${status} ${cid}`);
    console.log(`     username:      ${user}`);
    console.log(`     ip:            ${ip}`);
    console.log(`     subscriptions: ${subs}`);
    console.log(`     inbound:       ${inbound}`);
    console.log();
  }
}

/**
 * subs — Show agent subscriptions via HTTP API.
 */
async function cmdSubs(args) {
  const host      = args.host;
  const port      = args.port;
  const apiKey    = args.apiKey;
  const apiSecret = args.apiSecret;

  const result = await getSubscriptions(host, port, apiKey, apiSecret, args.clientid);
  const subs = Array.isArray(result) ? result : (result.data || []);

  if (!subs.length) {
    console.log(`Agent '${args.clientid}' has no subscriptions or not found.`);
    return;
  }

  console.log(`Agent: ${args.clientid}`);
  for (const s of subs) {
    const topic = s.topic || "?";
    const qos   = s.qos || 0;
    console.log(`  └─ ${topic}  (QoS ${qos})`);
  }
}

/**
 * send — Fire-and-forget publish via MQTT v5.
 *
 * Publishes to {targetClientId}/inbound with:
 *   userProperties: { name, description, emoji, reply_to }
 *
 * reply_to is set to {senderId}/inbound to follow mqtt-chat convention,
 * so the recipient knows exactly where to send responses.
 */
async function cmdSend(args) {
  const mqttHost = args.emqxMqttHost || args.host;
  const mqttPort = args.emqxMqttPort || 1883;

  const senderId   = args.senderId   || DEFAULT_SENDER_ID;
  const senderName = args.senderName || DEFAULT_SENDER_NAME;
  const senderEmoji = args.senderEmoji || DEFAULT_SENDER_EMOJI;
  const senderDesc = args.senderDesc || DEFAULT_SENDER_DESC;

  const targetTopic = resolveInboundTopic(args.agent);
  const replyTo     = resolveInboundTopic(senderId);

  const payload = buildMessage(args.msg, senderId);

  const userProperties = buildUserProperties(senderId, senderName, senderEmoji, senderDesc, replyTo);

  const client = await createMqttClient(mqttHost, mqttPort);
  try {
    await new Promise((resolve, reject) => {
      client.publish(
        targetTopic,
        payload,
        {
          qos: args.qos,
          properties: { userProperties },
        },
        (err) => (err ? reject(err) : resolve())
      );
    });

    console.error(`→ Sent to ${args.agent} on '${targetTopic}'`);
    console.error(`  Properties: name=${senderName}, emoji=${senderEmoji}, reply_to=${replyTo}`);
    console.error(`  Payload: ${payload.length > 200 ? payload.slice(0, 200) + "..." : payload}`);
    console.log(JSON.stringify({ status: "sent", agent: args.agent, topic: targetTopic }));
  } finally {
    client.end();
  }
}

/**
 * send-wait — Send message via MQTT v5, wait for reply (blocking).
 *
 * Creates a unique reply topic, subscribes to it, publishes the message with
 * reply_to set to the unique topic, then blocks collecting multiple replies
 * until idle timeout expires.
 *
 * Two timeouts:
 *   --timeout        Max seconds to wait for FIRST reply (default: 300)
 *   --idle-timeout   Seconds of silence after last reply before closing (default: 5)
 *
 * All replies are merged and printed to stdout as a JSON array.
 * On timeout with no reply, exits with code 1.
 */
async function cmdSendWait(args) {
  const mqttHost = args.emqxMqttHost || args.host;
  const mqttPort = args.emqxMqttPort || 1883;

  const senderId   = args.senderId   || DEFAULT_SENDER_ID;
  const senderName = args.senderName || DEFAULT_SENDER_NAME;
  const senderEmoji = args.senderEmoji || DEFAULT_SENDER_EMOJI;
  const senderDesc = args.senderDesc || DEFAULT_SENDER_DESC;

  const targetTopic = resolveInboundTopic(args.agent);
  const replyTopic  = `agent-reply/${shortId(16)}`;

  const payload = buildMessage(args.msg, senderId);
  const userProperties = buildUserProperties(senderId, senderName, senderEmoji, senderDesc, replyTopic);

  const firstTimeout = args.timeout;      // 首条回复超时
  const idleTimeout  = args.idleTimeout;   // 后续消息间隔超时

  const client = await createMqttClient(mqttHost, mqttPort, 15);  // MQTT connect timeout fixed at 15s

  return new Promise((resolve, reject) => {
    const received = [];
    let firstTimer = null;
    let idleTimer = null;
    let settled = false;
    let firstReplyArrived = false;

    function clearTimers() {
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      if (idleTimer)  { clearTimeout(idleTimer);  idleTimer  = null; }
    }

    function finish(output) {
      if (settled) return;
      settled = true;
      clearTimers();
      client.end();
      resolve(output);
    }

    // Timer: first reply must arrive within firstTimeout
    firstTimer = setTimeout(() => {
      if (firstReplyArrived) return; // already got at least one
      console.error(`! No reply received within ${firstTimeout}s timeout.`);
      process.exitCode = 1;
      finish(null);
    }, firstTimeout * 1000);

    // Idle timer helper: restarted after each message
    function resetIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        console.error(`Idle timeout (${idleTimeout}s), closing...`);
        // Merge all replies into stdout
        const merged = received.map(r => r.payload);
        console.log(JSON.stringify(merged));
        finish(merged);
      }, idleTimeout * 1000);
    }

    client.on("message", (topic, message, packet) => {
      const entry = {
        topic,
        payload: message.toString(),
        timestamp: Date.now(),
      };
      if (packet?.properties?.userProperties) {
        entry.userProperties = Object.fromEntries(
          Object.entries(packet.properties.userProperties)
        );
      }
      received.push(entry);

      const meta = entry.userProperties || {};
      console.error(`← Reply #${received.length} from ${meta.name || "?"} (${meta.description || ""}) ${meta.emoji || ""}`);
      console.error(`  ${entry.payload.slice(0, 120)}${entry.payload.length > 120 ? "..." : ""}`);

      firstReplyArrived = true;
      resetIdleTimer();
    });

    // 1. Subscribe to reply topic first (avoid missing reply)
    client.subscribe(replyTopic, { qos: args.qos }, (subErr) => {
      if (subErr) {
        clearTimers();
        client.end();
        reject(subErr);
        return;
      }

      // 2. Then publish the message (reply listener already active)
      client.publish(targetTopic, payload, {
        qos: args.qos,
        properties: { userProperties },
      }, (pubErr) => {
        if (pubErr) {
          clearTimers();
          client.end();
          reject(pubErr);
          return;
        }

        // 3. Now the message is actually sent
        console.error(`→ Sent to ${args.agent} on '${targetTopic}'`);
        console.error(`  Reply topic: ${replyTopic}  (collecting replies)`);
        console.error(`  Sender: ${senderName} (${senderId}) ${senderEmoji}`);
        console.error(`  First-reply timeout=${firstTimeout}s  idle-timeout=${idleTimeout}s`);
        console.error("");
      });
    });
  });
}

/**
 * listen — Daemon mode. Subscribe to {senderId}/inbound and print
 * incoming messages. Useful for debugging and monitoring.
 *
 * Stays running until Ctrl+C.
 */
async function cmdListen(args) {
  const mqttHost = args.emqxMqttHost || args.host;
  const mqttPort = args.emqxMqttPort || 1883;

  const senderId = args.senderId || DEFAULT_SENDER_ID;
  const inbox    = resolveInboundTopic(senderId);

  const client = await createMqttClient(mqttHost, mqttPort);

  client.subscribe(inbox, { qos: 1 }, (err) => {
    if (err) {
      console.error(`Subscribe error: ${err.message}`);
      process.exit(1);
    }
    console.log(`Listening on ${inbox} (QoS 1)`);
    console.log("Press Ctrl+C to stop.\n");
  });

  client.on("message", (topic, message, packet) => {
    const now = new Date().toISOString();
    let sender = "(unknown)";
    if (packet?.properties?.userProperties) {
      const up = packet.properties.userProperties;
      sender = `${up.name || "?"} / ${up.description || ""} ${up.emoji || ""}`;
    }
    console.log(`[${now}] ← ${topic}`);
    console.log(`  From:   ${sender}`);
    console.log(`  Body:   ${message.toString()}`);
    console.log();
  });

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\nStopped.");
    client.end();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    client.end();
    process.exit(0);
  });
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const { values: args, positionals } = parseArgs({
    options: {
      host:            { type: "string" },
      port:            { type: "string" },
      "api-key":       { type: "string" },
      "api-secret":    { type: "string" },
      "emqx-mqtt-host": { type: "string" },
      "emqx-mqtt-port": { type: "string" },
      "sender-id":     { type: "string" },
      "sender-name":   { type: "string" },
      "sender-emoji":  { type: "string" },
      "sender-desc":   { type: "string" },
      agent:           { type: "string" },
      msg:             { type: "string" },
      timeout:         { type: "string", default: "300" },
      "idle-timeout":  { type: "string", default: "15" },
      qos:             { type: "string", default: "1" },
      filter:          { type: "string" },
      help:            { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  const command = positionals[0];

  if (args.help || !command) {
    console.log(`EMQX Agent Communication Tool (MQTT.js / mqtt-chat protocol)

Commands:
  discover                    List agents with inbound topic details
  subs <clientid>             Show agent subscriptions
  send --agent <id> --msg <text>
                              Fire-and-forget publish via MQTT v5
  send-wait --agent <id> --msg <text> [--timeout <s>] [--idle-timeout <s>]
                              Send message + wait for reply (blocking)
  listen                      Listen on {senderId}/inbound

Options (all commands):
  --host            EMQX host (env: EMQX_HOST)
  --port            EMQX API port (env: EMQX_API_PORT, default: 18083)
  --api-key         API key ID (env: EMQX_API_KEY)
  --api-secret      API key secret (env: EMQX_API_SECRET)
  --emqx-mqtt-host  MQTT host override (env: EMQX_HOST if not set)
  --emqx-mqtt-port  MQTT port (env: EMQX_MQTT_PORT, default: 1883)

Options (send / send-wait / listen):
  --sender-id       Sender MQTT client ID (env: EMQX_SENDER_ID)
  --sender-name     Display name (env: EMQX_SENDER_NAME)
  --sender-emoji    Avatar emoji (env: EMQX_SENDER_EMOJI)
  --sender-desc     Description (env: EMQX_SENDER_DESC)
  --qos             MQTT QoS 0/1/2 (default: 1)

Options (send / send-wait):
  --agent           Target agent client ID (required)
  --msg             Message text (required)

Options (send-wait):
  --timeout         Max seconds for first reply (default: 300)
  --idle-timeout    Seconds of silence before closing (default: 15)

Options (discover):
  --filter          Filter by clientid pattern

Examples:
  node emqx_agent_communicate.mjs discover --filter "openclaw-"
  node emqx_agent_communicate.mjs subs openclaw-doc
  node emqx_agent_communicate.mjs send --agent openclaw-doc --msg "Hello"
  node emqx_agent_communicate.mjs send-wait --agent openclaw-doc --msg "汇报状态" --timeout 60 --idle-timeout 10
  node emqx_agent_communicate.mjs listen`);
    return;
  }

  // Resolve connection details
  args.host       = args.host      || getEnvOrRaise("EMQX_HOST");
  args.port       = parseInt(args.port || getEnvOrRaise("EMQX_API_PORT"), 10);
  args.apiKey     = args["api-key"] || getEnvOrRaise("EMQX_API_KEY");
  args.apiSecret  = args["api-secret"] || getEnvOrRaise("EMQX_API_SECRET");
  args.emqxMqttPort = parseInt(args["emqx-mqtt-port"] || getEnv("EMQX_MQTT_PORT") || "1883", 10);
  args.timeout     = parseInt(args.timeout, 10);
  args.idleTimeout = parseInt(args["idle-timeout"], 10);
  args.qos         = parseInt(args.qos, 10);

  switch (command) {
    case "discover":
      return cmdDiscover(args);
    case "subs": {
      args.clientid = positionals[1];
      if (!args.clientid) {
        console.error("Usage: emqx_agent_communicate subs <clientid>");
        process.exit(1);
      }
      return cmdSubs(args);
    }
    case "send": {
      if (!args.agent) {
        console.error("--agent is required.");
        process.exit(1);
      }
      if (!args.msg) {
        console.error("--msg is required.");
        process.exit(1);
      }
      return cmdSend(args);
    }
    case "send-wait": {
      if (!args.agent) {
        console.error("--agent is required.");
        process.exit(1);
      }
      if (!args.msg) {
        console.error("--msg is required.");
        process.exit(1);
      }
      return cmdSendWait(args);
    }
    case "listen":
      return cmdListen(args);
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Use --help for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
