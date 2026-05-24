#!/usr/bin/env python3
"""
EMQX Agent Communication & Task Distribution Tool

Follows the MQTT Chat app conventions:
- MQTT v5 protocol with user properties for sender identity
- Message JSON format: {id, text, senderId, timestamp, type, ...}
- Private messages: publish to {targetClientId}/inbound
- Reply routing via user property reply_to = {senderId}/inbound

Usage:
    export EMQX_HOST="localhost"
    export EMQX_API_PORT="18083"
    export EMQX_API_KEY="my-key"
    export EMQX_API_SECRET="my-secret"

    # Optional identity config
    export EMQX_SENDER_ID="openclaw-malong"
    export EMQX_SENDER_NAME="马龙 🛠️"
    export EMQX_SENDER_EMOJI="🛠️"
    export EMQX_SENDER_DESC="开发管理"

    # Send and wait for reply
    python3 emqx_agent_communicate.py send-wait --agent openclaw-doc --task status --timeout 30

    # Fire-and-forget
    python3 emqx_agent_communicate.py send --agent openclaw-doc --msg "请检查系统状态"
"""

import argparse
import json
import os
import sys
import time
import uuid
import urllib.request
import urllib.error
import base64
import ssl
import threading
import datetime

import paho.mqtt.client as mqtt
from paho.mqtt.properties import Properties
from paho.mqtt.packettypes import PacketTypes


# ── Default sender identity (matching chat app convention) ─────────────

DEFAULT_SENDER_ID = os.environ.get("EMQX_SENDER_ID", "openclaw-malong")
DEFAULT_SENDER_NAME = os.environ.get("EMQX_SENDER_NAME", "马龙 🛠️")
DEFAULT_SENDER_EMOJI = os.environ.get("EMQX_SENDER_EMOJI", "🛠️")
DEFAULT_SENDER_DESC = os.environ.get("EMQX_SENDER_DESC", "开发管理")


# ── HTTP helpers (for read-only API calls: subs, discover) ──────────────

def get_env_or_raise(key):
    val = os.environ.get(key)
    if not val:
        print("Error: {} not set.".format(key), file=sys.stderr)
        sys.exit(1)
    return val


def build_auth_header(api_key, api_secret):
    creds = "{}:{}".format(api_key, api_secret)
    encoded = base64.b64encode(creds.encode("utf-8")).decode("utf-8")
    return "Basic {}".format(encoded)


def emqx_get(path, host, port, api_key, api_secret, params=None):
    base_url = "http://{}:{}/api/v5{}".format(host, port, path)
    if params:
        parts = []
        for k, v in params.items():
            if v is not None:
                parts.append("{}={}".format(k, urllib.request.quote(str(v), safe='')))
        base_url += "?" + "&".join(parts)
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
        print("HTTP {}: {}".format(e.code, body), file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print("Connection error: {}".format(e.reason), file=sys.stderr)
        sys.exit(1)


def fetch_clients(host, port, api_key, api_secret, limit=1000, like=None):
    return emqx_get("/clients", host, port, api_key, api_secret,
                    {"page": 1, "limit": limit, "like": like})


def get_subscriptions(host, port, api_key, api_secret, clientid):
    return emqx_get("/clients/{}/subscriptions".format(clientid),
                    host, port, api_key, api_secret)


# ── Message format (matching mqtt-chat app conventions) ─────────────

TASK_TEMPLATES = {
    "status": {
        "type": "task",
        "action": "status_report",
        "description": "Request agent status report",
        "payload": {}
    },
    "health": {
        "type": "task",
        "action": "health_check",
        "description": "Request health check",
        "payload": {"checks": ["cpu", "memory", "disk", "uptime"]}
    },
    "inventory": {
        "type": "task",
        "action": "inventory",
        "description": "Request inventory report",
        "payload": {}
    },
    "ping": {
        "type": "task",
        "action": "ping",
        "description": "Ping the agent",
        "payload": {"timestamp": ""}
    },
    "custom": {
        "type": "task",
        "action": "custom",
        "description": "Custom task",
        "payload": {}
    },
}


def build_message(text, sender_id, msg_type="text", extra=None):
    """Build a JSON message following mqtt-chat app convention."""
    msg = {
        "id": uuid.uuid4().hex[:12],
        "text": text,
        "senderId": sender_id,
        "timestamp": datetime.datetime.now().isoformat(),
        "type": msg_type,
    }
    if extra:
        msg.update(extra)
    return json.dumps(msg, ensure_ascii=False)


def build_task_payload(task_name, sender_id, params=None):
    """Build a structured task as a chat message with task info in extra fields."""
    template = TASK_TEMPLATES.get(task_name, TASK_TEMPLATES["custom"])
    extra = {
        "kind": "task",
        "action": template["action"],
        "description": template["description"],
        "task_name": task_name,
        "payload": dict(template["payload"]),
    }
    if params:
        extra["payload"].update(params)
    return build_message(
        text=template["description"],
        sender_id=sender_id,
        extra=extra,
    )


def resolve_inbound_topic(agent_id):
    """Inbound topic convention: {clientId}/inbound"""
    return "{}/inbound".format(agent_id)


def reply_topic_for(prefix="agent-reply"):
    return "{}/{}".format(prefix, uuid.uuid4().hex[:12])


def make_publish_properties(sender_id, sender_name, sender_emoji, sender_desc, reply_topic=None):
    """Build MQTT v5 publish properties with userProperties matching chat app convention."""
    props = Properties(PacketTypes.PUBLISH)
    uprops = [
        ("name", sender_name or sender_id),
        ("description", sender_desc or ""),
        ("emoji", sender_emoji or "👤"),
    ]
    if reply_topic:
        uprops.append(("reply_to", reply_topic))
    props.UserProperty = uprops
    return props


def _add_shared_args(p):
    """Add shared args to a subparser."""
    p.add_argument("--sender-id", default=DEFAULT_SENDER_ID,
                   help="Sender MQTT client ID (default: EMQX_SENDER_ID or '{}')".format(DEFAULT_SENDER_ID))
    p.add_argument("--sender-name", default=DEFAULT_SENDER_NAME,
                   help="Sender display name (default: EMQX_SENDER_NAME or '{}')".format(DEFAULT_SENDER_NAME))
    p.add_argument("--sender-emoji", default=DEFAULT_SENDER_EMOJI,
                   help="Sender emoji (default: EMQX_SENDER_EMOJI or '{}')".format(DEFAULT_SENDER_EMOJI))
    p.add_argument("--sender-desc", default=DEFAULT_SENDER_DESC,
                   help="Sender description (default: EMQX_SENDER_DESC or '{}')".format(DEFAULT_SENDER_DESC))
    p.add_argument("--qos", type=int, default=1, choices=[0, 1, 2],
                   help="MQTT QoS level")


def _mqtt_connect(host, port, timeout=30):
    """Create and connect a paho-mqtt v5 client."""
    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv5,
    )
    client.connect(host, port, keepalive=timeout + 5)
    return client


# ── Commands ─────────────────────────────────────────────────────────

def cmd_subs(args):
    result = get_subscriptions(args.host, args.port, args.api_key,
                               args.api_secret, args.clientid)
    if isinstance(result, list):
        subs = result
    else:
        subs = result.get("data", [])
    if not subs:
        print("Agent '{}' has no subscriptions or not found.".format(args.clientid))
        return
    print("Agent: {}".format(args.clientid))
    for s in subs:
        topic = s.get("topic", "?")
        qos = s.get("qos", 0)
        print("  \u2514\u2500 {}  (QoS {})".format(topic, qos))


def cmd_send(args):
    """Fire-and-forget: send a chat-format message via MQTT v5."""
    mqtt_host = args.emqx_mqtt_host or args.host
    mqtt_port = args.emqx_mqtt_port or 1883

    sender_id = args.sender_id or DEFAULT_SENDER_ID
    sender_name = args.sender_name or DEFAULT_SENDER_NAME
    sender_emoji = args.sender_emoji or DEFAULT_SENDER_EMOJI
    sender_desc = args.sender_desc or DEFAULT_SENDER_DESC

    if args.task:
        payload = build_task_payload(args.task, sender_id, args.params)
    else:
        payload = build_message(args.msg or "", sender_id)

    target_topic = resolve_inbound_topic(args.agent)
    reply_to = "{}/inbound".format(sender_id)
    props = make_publish_properties(sender_id, sender_name, sender_emoji, sender_desc, reply_to)

    client = _mqtt_connect(mqtt_host, mqtt_port)
    info = client.publish(target_topic, payload, qos=args.qos, properties=props)
    client.disconnect()

    print("\u2192 Sent to {} on '{}'".format(args.agent, target_topic))
    print("  RC: {}  MsgID: {}".format(info.rc, info.mid))
    print("  Properties: name={}, emoji={}, reply_to={}".format(sender_name, sender_emoji, reply_to))
    print("  Payload: {}{}".format(
        payload[:200], "..." if len(payload) > 200 else ""))


def cmd_send_wait(args):
    """Send task with reply routing via MQTT v5, wait for agent response."""
    mqtt_host = args.emqx_mqtt_host or args.host
    mqtt_port = args.emqx_mqtt_port or 1883

    sender_id = args.sender_id or DEFAULT_SENDER_ID
    sender_name = args.sender_name or DEFAULT_SENDER_NAME
    sender_emoji = args.sender_emoji or DEFAULT_SENDER_EMOJI
    sender_desc = args.sender_desc or DEFAULT_SENDER_DESC

    target_topic = resolve_inbound_topic(args.agent)
    reply_topic = reply_topic_for()

    payload = build_task_payload(args.task, sender_id, args.params)
    # In send-wait, reply_to in userProperties points to the unique reply topic
    props = make_publish_properties(sender_id, sender_name, sender_emoji, sender_desc, reply_topic)

    received = []
    event = threading.Event()

    def on_connect(client, userdata, flags, reasonCode, properties=None):
        # Subscribe to reply topic first, then publish the task
        client.subscribe(reply_topic, qos=args.qos)
        client.publish(target_topic, payload, qos=args.qos, properties=props)

    def on_message(client, userdata, msg):
        entry = {
            "topic": msg.topic,
            "payload": msg.payload.decode("utf-8", errors="replace"),
            "timestamp": time.time(),
        }
        # Extract user properties from the reply packet
        if msg.properties and msg.properties.UserProperty:
            uprops = dict(msg.properties.UserProperty)
            entry["user_properties"] = uprops
        received.append(entry)
        event.set()

    client = mqtt.Client(
        mqtt.CallbackAPIVersion.VERSION2,
        protocol=mqtt.MQTTv5,
    )
    client.on_connect = on_connect
    client.on_message = on_message

    try:
        client.connect(mqtt_host, mqtt_port, keepalive=args.timeout + 5)
        client.loop_start()

        print("\u2192 Sent to {} on '{}'".format(args.agent, target_topic))
        print("  Reply topic: {}".format(reply_topic))
        print("  Sender: {} ({}) {}".format(sender_name, sender_id, sender_emoji))
        print("  Waiting for reply (timeout={}s)...".format(args.timeout))
        print()

        got = event.wait(timeout=args.timeout)
        client.loop_stop()
        client.disconnect()
    except Exception as e:
        print("MQTT error: {}".format(e), file=sys.stderr)
        sys.exit(1)

    if not got or not received:
        print("! No reply received within {}s timeout.".format(args.timeout))
        sys.exit(1)

    print("--- Reply received ---\n")
    for r in received:
        if "user_properties" in r:
            up = r["user_properties"]
            print("  From: {} ({}) {}".format(
                up.get("name", "?"), up.get("description", ""), up.get("emoji", "")))
        print("  Topic: {}".format(r["topic"]))
        print("  Payload: {}".format(r["payload"]))
        print()


def cmd_discover(args):
    resp = fetch_clients(args.host, args.port, args.api_key,
                         args.api_secret, 1000, args.filter)
    clients = resp.get("data", [])
    if not clients:
        print("No agents found.")
        return

    print("Discovered {} agent(s):\n".format(len(clients)))
    for c in clients:
        cid = c.get("clientid", "?")
        user = c.get("username", "?")
        ip = c.get("ip_address", "?")
        connected = c.get("connected", False)
        subs = c.get("subscriptions_cnt", 0)
        status = "\U0001f7e2" if connected else "\U0001f534"
        inbound_topic = resolve_inbound_topic(cid)
        print("  {} {}".format(status, cid))
        print("     username:      {}".format(user))
        print("     ip:            {}".format(ip))
        print("     subscriptions: {}".format(subs))
        print("     inbound:       {}".format(inbound_topic))
        print()


# ── Entry point ──────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="EMQX Agent Communication & Task Distribution (MQTT v5)"
    )
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", default=None)
    parser.add_argument("--api-key", default=None)
    parser.add_argument("--api-secret", default=None)
    parser.add_argument("--emqx-mqtt-host", default=None,
                        help="EMQX MQTT host for publish/subscribe (default: same as --host)")
    parser.add_argument("--emqx-mqtt-port", type=int, default=None,
                        help="EMQX MQTT port (default: 1883)")

    sub = parser.add_subparsers(dest="command", required=True)

    # subs
    p = sub.add_parser("subs", help="Show agent subscriptions (via HTTP API)")
    p.add_argument("clientid", help="Agent client ID")
    p.set_defaults(func=cmd_subs)

    # send
    p = sub.add_parser("send", help="Send message/task via MQTT v5 (fire and forget)")
    _add_shared_args(p)
    p.add_argument("--agent", required=True, help="Target agent client ID")
    p.add_argument("--msg", default=None, help="Plain text message")
    p.add_argument("--task", default=None,
                   choices=list(TASK_TEMPLATES.keys()),
                   help="Structured task type")
    p.add_argument("--params", default=None, help='JSON params for custom task')
    p.set_defaults(func=cmd_send)

    # send-wait
    p = sub.add_parser("send-wait",
                        help="Send task via MQTT v5 and wait for reply (blocks)")
    _add_shared_args(p)
    p.add_argument("--agent", required=True, help="Target agent client ID")
    p.add_argument("--task", default=None,
                   choices=list(TASK_TEMPLATES.keys()),
                   help="Structured task type")
    p.add_argument("--params", default=None, help='JSON params for custom task')
    p.add_argument("--timeout", type=int, default=15,
                   help="Max seconds to wait for reply (default: 15)")
    p.set_defaults(func=cmd_send_wait)

    # discover
    p = sub.add_parser("discover", help="Discover agents with details (via HTTP API)")
    p.add_argument("--filter", default=None, help="Filter by clientid pattern")
    p.set_defaults(func=cmd_discover)

    args = parser.parse_args()

    # Resolve connection details
    args.host = args.host or get_env_or_raise("EMQX_HOST")
    args.port = int(args.port or get_env_or_raise("EMQX_API_PORT"))
    args.api_key = args.api_key or get_env_or_raise("EMQX_API_KEY")
    args.api_secret = args.api_secret or get_env_or_raise("EMQX_API_SECRET")

    if hasattr(args, 'params') and args.params:
        try:
            args.params = json.loads(args.params)
        except json.JSONDecodeError as e:
            print("Invalid JSON in --params: {}".format(e), file=sys.stderr)
            sys.exit(1)
    elif hasattr(args, 'params'):
        args.params = {}

    args.func(args)


if __name__ == "__main__":
    main()
