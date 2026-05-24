#!/usr/bin/env python3
"""
EMQX MQTT Agent Discovery Tool

Discover agents connected to EMQX broker. Lists all MQTT client connections
and provides agent identity, presence, and connectivity info for cross-agent communication.

Usage:
    export EMQX_HOST="localhost"
    export EMQX_API_PORT="18083"
    export EMQX_API_KEY="my-key"
    export EMQX_API_SECRET="my-secret"

    # Discover all connected agents
    python3 emqx_list_clients.py

    # Show agent connectivity endpoints
    python3 emqx_list_clients.py --endpoints

    # Watch for agent presence changes
    python3 emqx_list_clients.py --watch

    # Filter by agent name pattern
    python3 emqx_list_clients.py --search "openclaw-"

    # JSON output for programmatic use
    python3 emqx_list_clients.py --json
"""

import argparse
import json
import os
import sys
import time
import urllib.request
import urllib.error
import base64
import ssl


def get_env_or_raise(key):
    val = os.environ.get(key)
    if not val:
        print(f"Error: {key} not set. Set env var or pass via --flag.", file=sys.stderr)
        sys.exit(1)
    return val


def build_auth_header(api_key, api_secret):
    creds = f"{api_key}:{api_secret}"
    encoded = base64.b64encode(creds.encode("utf-8")).decode("utf-8")
    return f"Basic {encoded}"


def emqx_get(path, host, port, api_key, api_secret, params=None):
    """Generic EMQX API GET request."""
    base_url = f"http://{host}:{port}/api/v5{path}"
    if params:
        qs = "&".join(f"{k}={urllib.request.quote(str(v), safe='')}" for k, v in params.items())
        base_url += f"?{qs}"

    req = urllib.request.Request(
        base_url,
        headers={
            "Accept": "application/json",
            "Authorization": build_auth_header(api_key, api_secret),
        },
    )
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code}: {body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Connection error: {e.reason} (tried: {base_url})", file=sys.stderr)
        sys.exit(1)


def fetch_clients(host, port, api_key, api_secret, limit=100, page=1, node=None, state=None, like=None):
    params = {"page": page, "limit": limit}
    if node:
        params["node"] = node
    if state:
        params["state"] = state
    if like:
        params["like"] = like
    return emqx_get("/clients", host, port, api_key, api_secret, params)


def fetch_all_clients(host, port, api_key, api_secret, limit=100, node=None, state=None, like=None):
    all_data = []
    page = 1
    meta = {}

    while True:
        resp = fetch_clients(host, port, api_key, api_secret, limit, page, node, state, like)
        data = resp.get("data", [])
        meta = resp.get("meta", {})
        all_data.extend(data)
        if not meta.get("hasnext", False):
            break
        page += 1

    return all_data, meta


def get_node_info(host, port, api_key, api_secret):
    """Get cluster node info for MQTT listener endpoints."""
    return emqx_get("/nodes", host, port, api_key, api_secret)


def build_agent_endpoints(clients, nodes):
    """Build MQTT connectivity info for each agent based on its serving node."""
    # Build node -> IP mapping from node info
    node_ips = {}
    for n in nodes:
        name = n.get("name", "")
        # Use the node's own IP, default to the connection IP
        node_ips[name] = n.get("ip", "")

    results = []
    for c in clients:
        node = c.get("node", "")
        clientid = c.get("clientid", "")
        username = c.get("username", "")
        ip = c.get("ip_address", "")
        port = c.get("port", 0)
        connected = c.get("connected", False)
        proto_ver = c.get("proto_ver", 4)
        subscriptions_cnt = c.get("subscriptions_cnt", 0)

        # Build endpoint info
        endpoint = {
            "agent_id": clientid,
            "username": username,
            "connected": connected,
            "ip": ip,
            "port": port,
            "node": node,
            "node_ip": node_ips.get(node, ""),
            "protocol": f"MQTT v{proto_ver}" if proto_ver else "MQTT",
            "subscriptions": subscriptions_cnt,
        }
        results.append(endpoint)

    return results


def format_table(agents, fields):
    """Format agent list as a readable table."""
    if not agents:
        return "No agents found."

    col_widths = {}
    for f in fields:
        key = f.get("key", f.get("label", ""))
        col_widths[key] = len(f["label"])

    for a in agents:
        for f in fields:
            key = f.get("key", f.get("label", ""))
            val = str(a.get(key, ""))
            col_widths[key] = max(col_widths[key], len(val))

    header = "  ".join(f["label"].ljust(col_widths[f.get("key", f.get("label", ""))]) for f in fields)
    sep = "  ".join("-" * col_widths[f.get("key", f.get("label", ""))] for f in fields)

    lines = [header, sep]
    for a in agents:
        row = []
        for f in fields:
            key = f.get("key", f.get("label", ""))
            val = str(a.get(key, ""))
            row.append(val.ljust(col_widths[key]))
        lines.append("  ".join(row))

    return "\n".join(lines)


def render_agent_card(agent):
    """Render a single agent's detail card."""
    lines = [
        f"┌─ Agent: {agent['agent_id']}",
        f"├ Username:      {agent['username']}",
        f"├ Status:        {'🟢 ONLINE' if agent['connected'] else '🔴 OFFLINE'}",
        f"├ MQTT Address:  {agent['ip']}:{agent['port']}",
        f"├ Node:          {agent['node']} ({agent['node_ip']})",
        f"├ Protocol:      {agent['protocol']}",
        f"└ Subscriptions: {agent['subscriptions']}",
    ]
    return "\n".join(lines)


def watch_agents(host, port, api_key, api_secret, interval=5, limit=100):
    """Watch mode: poll for agent presence changes."""
    previous = set()
    print(f"Watching EMQX agents on {host}:{port} (poll every {interval}s)...")
    print("Press Ctrl+C to stop.\n")

    try:
        while True:
            clients, meta = fetch_all_clients(host, port, api_key, api_secret, limit)
            current = {c["clientid"] for c in clients if "clientid" in c}

            joined = current - previous
            left = previous - current

            now = time.strftime("%H:%M:%S")
            for j in joined:
                client = next((c for c in clients if c["clientid"] == j), {})
                ip = client.get("ip_address", "?")
                user = client.get("username", "?")
                print(f"[{now}] ➜ JOINED  {j}  (user={user}, ip={ip})")

            for l in left:
                print(f"[{now}] ✜ LEFT    {l}")

            if not joined and not left:
                print(f"[{now}] No changes ({len(current)} agents online)")

            previous = current
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nStopped.")


def main():
    parser = argparse.ArgumentParser(
        description="EMQX MQTT Agent Discovery — find connected agents on the broker"
    )
    parser.add_argument("--host", default=None, help="EMQX host (default: $EMQX_HOST)")
    parser.add_argument("--port", default=None, help="EMQX API port (default: $EMQX_API_PORT)")
    parser.add_argument("--api-key", default=None, help="EMQX API key ID (default: $EMQX_API_KEY)")
    parser.add_argument("--api-secret", default=None, help="EMQX API secret (default: $EMQX_API_SECRET)")
    parser.add_argument("--limit", type=int, default=100, help="Page size (default: 100, max: 10000)")

    # Filters
    parser.add_argument("--node", default=None, help="Filter by EMQX node")
    parser.add_argument("--state", default=None, choices=["connected", "disconnected"],
                        help="Filter by connection state")
    parser.add_argument("--search", "--like", dest="like", default=None,
                        help="Search agent clientid by pattern")

    # Output modes
    parser.add_argument("--json", action="store_true", help="Output as JSON array")
    parser.add_argument("--raw", action="store_true", help="Output raw API response")
    parser.add_argument("--summary", action="store_true", help="Show agent count only")
    parser.add_argument("--endpoints", action="store_true",
                        help="Show with MQTT endpoint info for cross-agent communication")
    parser.add_argument("--watch", action="store_true",
                        help="Watch agent presence changes (polling)")
    parser.add_argument("--watch-interval", type=int, default=5,
                        help="Watch polling interval in seconds (default: 5)")
    parser.add_argument("--no-pager", action="store_true",
                        help="Single page only (no auto-pagination)")

    args = parser.parse_args()

    host = args.host or get_env_or_raise("EMQX_HOST")
    port = int(args.port or get_env_or_raise("EMQX_API_PORT"))
    api_key = args.api_key or get_env_or_raise("EMQX_API_KEY")
    api_secret = args.api_secret or get_env_or_raise("EMQX_API_SECRET")

    # Watch mode
    if args.watch:
        watch_agents(host, port, api_key, api_secret, args.watch_interval, args.limit)
        return

    # Fetch clients
    if args.no_pager:
        resp = fetch_clients(host, port, api_key, api_secret,
                             args.limit, 1, args.node, args.state, args.like)
        clients = resp.get("data", [])
        meta = resp.get("meta", {})
    else:
        clients, meta = fetch_all_clients(host, port, api_key, api_secret,
                                           args.limit, args.node, args.state, args.like)

    count = len(clients)
    meta_count = meta.get("count", count)

    # Enrich with node info if endpoints requested
    if args.endpoints:
        nodes = get_node_info(host, port, api_key, api_secret)
        agents = build_agent_endpoints(clients, nodes)
    else:
        agents = clients

    # Output
    if args.raw:
        print(json.dumps({"data": clients, "meta": meta}, indent=2, ensure_ascii=False))
        return

    if args.json:
        print(json.dumps(agents, indent=2, ensure_ascii=False))
        return

    if args.summary:
        label = "agents" if not args.state else f"agents ({args.state})"
        print(f"Total {label}: {count}")
        return

    if args.endpoints:
        # Agent detail cards
        for a in agents:
            print(render_agent_card(a))
            print()
        print(f"---\nTotal agents: {count}")
    else:
        # Table view - agent-focused fields
        fields = [
            {"key": "clientid", "label": "AGENT_ID"},
            {"key": "username", "label": "USERNAME"},
            {"key": "ip_address", "label": "IP"},
            {"key": "port", "label": "PORT"},
            {"key": "proto_name", "label": "PROTO"},
            {"key": "connected_at", "label": "ONLINE_SINCE"},
            {"key": "subscriptions_cnt", "label": "SUBS"},
            {"key": "node", "label": "NODE"},
        ]
        print(format_table(agents, fields))
        print(f"\nTotal agents: {count}")


if __name__ == "__main__":
    main()
