#!/usr/bin/env node
/**
 * EMQX MQTT Agent Discovery Tool (MQTT.js / Node.js)
 *
 * Discover agents connected to EMQX broker. Lists all MQTT client connections
 * and provides agent identity, presence, and connectivity info for cross-agent
 * communication.
 *
 * Follows mqtt-chat conventions:
 *   - Agent identity via MQTT v5 userProperties: { name, description, emoji }
 *   - Inbound topic pattern: {clientId}/inbound
 *
 * Usage:
 *   node emqx_list_clients.mjs
 *   node emqx_list_clients.mjs --endpoints
 *   node emqx_list_clients.mjs --watch
 *   node emqx_list_clients.mjs --search "openclaw-"
 *   node emqx_list_clients.mjs --json
 *   node emqx_list_clients.mjs --state connected
 *
 * Environment:
 *   EMQX_HOST          EMQX broker host
 *   EMQX_API_PORT      EMQX API port (default: 18083)
 *   EMQX_API_KEY       API key ID
 *   EMQX_API_SECRET    API key secret
 */

import { parseArgs } from "node:util";

// ── Environment helpers ────────────────────────────────────────────────

function getEnv(key) {
  return process.env[key] || "";
}

function getEnvOrRaise(key) {
  const val = getEnv(key);
  if (!val) {
    console.error(`Error: ${key} not set. Set env var or pass via --flag.`);
    process.exit(1);
  }
  return val;
}

// ── HTTP helpers ───────────────────────────────────────────────────────

function buildAuthHeader(apiKey, apiSecret) {
  const creds = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  return `Basic ${creds}`;
}

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

  try {
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
    return await res.json();
  } catch (err) {
    if (err.name === "TimeoutError") {
      console.error(`Connection timeout: ${url}`);
    } else {
      console.error(`Connection error: ${err.message} (tried: ${url})`);
    }
    process.exit(1);
  }
}

// ── Data fetching ──────────────────────────────────────────────────────

async function fetchClients(host, port, apiKey, apiSecret, limit = 100, page = 1, node, state, like) {
  const params = { page, limit };
  if (node) params.node = node;
  if (state) params.state = state;
  if (like) params.like = like;
  return emqxGet("/clients", host, port, apiKey, apiSecret, params);
}

async function fetchAllClients(host, port, apiKey, apiSecret, limit = 100, node, state, like) {
  const all = [];
  let page = 1;
  let meta = {};

  while (true) {
    const resp = await fetchClients(host, port, apiKey, apiSecret, limit, page, node, state, like);
    const data = resp.data || [];
    meta = resp.meta || {};
    all.push(...data);
    if (!meta.hasnext) break;
    page++;
  }

  return { clients: all, meta };
}

async function getNodeInfo(host, port, apiKey, apiSecret) {
  return emqxGet("/nodes", host, port, apiKey, apiSecret);
}

// ── Agent endpoints builder ────────────────────────────────────────────

function buildAgentEndpoints(clients, nodes) {
  const nodeIps = {};
  for (const n of nodes) {
    nodeIps[n.name || ""] = n.ip || "";
  }

  return clients.map((c) => ({
    agent_id: c.clientid || "",
    username: c.username || "",
    connected: !!c.connected,
    ip: c.ip_address || "",
    port: c.port || 0,
    node: c.node || "",
    node_ip: nodeIps[c.node || ""] || "",
    protocol: c.proto_ver ? `MQTT v${c.proto_ver}` : "MQTT",
    subscriptions: c.subscriptions_cnt || 0,
    connected_at: c.connected_at || "",
  }));
}

// ── Output formatters ──────────────────────────────────────────────────

function pad(str, len) {
  return String(str).padEnd(len);
}

function formatTable(agents, fields) {
  if (!agents.length) return "No agents found.";

  const colWidths = {};
  for (const f of fields) {
    const key = f.key || f.label;
    colWidths[key] = f.label.length;
    for (const a of agents) {
      const val = String(a[key] ?? "");
      colWidths[key] = Math.max(colWidths[key], val.length);
    }
  }

  const header = fields.map((f) => pad(f.label, colWidths[f.key || f.label])).join("  ");
  const sep = fields.map((f) => "-".repeat(colWidths[f.key || f.label])).join("  ");

  const rows = agents.map((a) =>
    fields.map((f) => pad(String(a[f.key || f.label] ?? ""), colWidths[f.key || f.label])).join("  ")
  );

  return [header, sep, ...rows].join("\n");
}

function renderAgentCard(agent) {
  const status = agent.connected ? "🟢 ONLINE" : "🔴 OFFLINE";
  return [
    `┌─ Agent: ${agent.agent_id}`,
    `├ Username:      ${agent.username}`,
    `├ Status:        ${status}`,
    `├ MQTT Address:  ${agent.ip}:${agent.port}`,
    `├ Node:          ${agent.node} (${agent.node_ip})`,
    `├ Protocol:      ${agent.protocol}`,
    `├ Connected:     ${agent.connected_at}`,
    `└ Subscriptions: ${agent.subscriptions}`,
  ].join("\n");
}

// ── Watch mode ─────────────────────────────────────────────────────────

async function watchAgents(host, port, apiKey, apiSecret, interval = 5, limit = 100) {
  let previous = new Set();
  console.log(`Watching EMQX agents on ${host}:${port} (poll every ${interval}s)...`);
  console.log("Press Ctrl+C to stop.\n");

  while (true) {
    try {
      const { clients } = await fetchAllClients(host, port, apiKey, apiSecret, limit);
      const current = new Set(clients.map((c) => c.clientid).filter(Boolean));

      const joined = [...current].filter((id) => !previous.has(id));
      const left = [...previous].filter((id) => !current.has(id));

      const now = new Date().toLocaleTimeString();
      for (const j of joined) {
        const client = clients.find((c) => c.clientid === j) || {};
        const ip = client.ip_address || "?";
        const user = client.username || "?";
        console.log(`[${now}] ➜ JOINED  ${j}  (user=${user}, ip=${ip})`);
      }
      for (const l of left) {
        console.log(`[${now}] ✜ LEFT    ${l}`);
      }
      if (!joined.length && !left.length) {
        console.log(`[${now}] No changes (${current.size} agents online)`);
      }

      previous = current;
    } catch (err) {
      console.error(`Watch error: ${err.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const { values: args } = parseArgs({
    options: {
      host:       { type: "string" },
      port:       { type: "string" },
      "api-key":  { type: "string" },
      "api-secret": { type: "string" },
      limit:      { type: "string", default: "100" },
      node:       { type: "string" },
      state:      { type: "string" },
      search:     { type: "string" },
      like:       { type: "string" },
      json:       { type: "boolean", default: false },
      raw:        { type: "boolean", default: false },
      summary:    { type: "boolean", default: false },
      endpoints:  { type: "boolean", default: false },
      watch:      { type: "boolean", default: false },
      "watch-interval": { type: "string", default: "5" },
      "no-pager": { type: "boolean", default: false },
      help:       { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (args.help) {
    console.log(`Usage: node emqx_list_clients.mjs [options]

Options:
  --host <addr>         EMQX host (default: \$EMQX_HOST)
  --port <port>         EMQX API port (default: \$EMQX_API_PORT)
  --api-key <key>       EMQX API key ID (default: \$EMQX_API_KEY)
  --api-secret <sec>    EMQX API secret (default: \$EMQX_API_SECRET)
  --limit <n>           Page size (default: 100)
  --node <name>         Filter by node
  --state <s>           Filter by state (connected|disconnected)
  --search <pattern>    Filter by clientid pattern
  --like <pattern>      Same as --search
  --json                Output as JSON
  --raw                 Raw API response
  --summary             Agent count only
  --endpoints           Show with MQTT endpoint info
  --watch               Watch presence changes (polling)
  --watch-interval <n>  Poll interval in seconds (default: 5)
  --no-pager            Single page only`);
    return;
  }

  const host       = args.host       || getEnv("EMQX_HOST");
  const port       = parseInt(args.port || getEnv("EMQX_API_PORT") || "0", 10);
  const apiKey     = args["api-key"] || getEnv("EMQX_API_KEY");
  const apiSecret  = args["api-secret"] || getEnv("EMQX_API_SECRET");

  if (!host || !port || !apiKey || !apiSecret) {
    console.error("Error: EMQX_HOST, EMQX_API_PORT, EMQX_API_KEY, EMQX_API_SECRET must be set.");
    process.exit(1);
  }
  const limit      = parseInt(args.limit, 10);
  const node       = args.node;
  const state      = args.state;
  const like       = args.search || args.like;
  const watchInterval = parseInt(args["watch-interval"], 10);

  // Watch mode
  if (args.watch) {
    await watchAgents(host, port, apiKey, apiSecret, watchInterval, limit);
    return;
  }

  // Fetch clients
  let clients, meta;
  if (args["no-pager"]) {
    const resp = await fetchClients(host, port, apiKey, apiSecret, limit, 1, node, state, like);
    clients = resp.data || [];
    meta = resp.meta || {};
  } else {
    const result = await fetchAllClients(host, port, apiKey, apiSecret, limit, node, state, like);
    clients = result.clients;
    meta = result.meta;
  }

  const count = clients.length;
  const metaCount = meta.count || count;

  // Enrich with node info if endpoints requested
  let agents = clients;
  if (args.endpoints) {
    const nodes = await getNodeInfo(host, port, apiKey, apiSecret);
    agents = buildAgentEndpoints(clients, nodes);
  }

  // Output
  if (args.raw) {
    console.log(JSON.stringify({ data: clients, meta }, null, 2));
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(agents, null, 2));
    return;
  }

  if (args.summary) {
    const label = state ? `agents (${state})` : "agents";
    console.log(`Total ${label}: ${count}`);
    return;
  }

  if (args.endpoints) {
    for (const a of agents) {
      console.log(renderAgentCard(a));
      console.log();
    }
    console.log(`---\nTotal agents: ${count}`);
  } else {
    const fields = [
      { key: "clientid",         label: "AGENT_ID" },
      { key: "username",         label: "USERNAME" },
      { key: "ip_address",       label: "IP" },
      { key: "port",             label: "PORT" },
      { key: "proto_name",       label: "PROTO" },
      { key: "connected_at",     label: "ONLINE_SINCE" },
      { key: "subscriptions_cnt", label: "SUBS" },
      { key: "node",             label: "NODE" },
    ];
    console.log(formatTable(agents, fields));
    console.log(`\nTotal agents: ${count}`);
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
