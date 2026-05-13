import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { MqttCoreConfig, MqttMessage } from "./types.js";
import { createMqttClient, MqttClientManager } from "./client.js";
import { mqttOnboardingAdapter } from "./onboarding.js";
import { getMqttRuntime } from "./runtime.js";
import * as fs from "fs";
import * as path from "path";

// Global client instance (one per gateway lifecycle)
let mqttClient: MqttClientManager | null = null;

// Store reply topics for active conversations: senderId -> replyTopic
const replyTopicMap: Map<string, string> = new Map();

// Track group members for session cleanup on dismiss: groupTopic -> Set<senderId>
const groupMembersMap: Map<string, Set<string>> = new Map();

// File size limit: 10MB
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * MQTT Channel Plugin for OpenClaw
 *
 * Provides bidirectional messaging via MQTT brokers (Mosquitto, EMQX, etc.)
 * Useful for IoT integration, home automation alerts, and service monitoring.
 */
export const mqttPlugin: ChannelPlugin<MqttCoreConfig> = {
  id: "mqtt",

  meta: {
    id: "mqtt",
    label: "MQTT",
    selectionLabel: "MQTT (IoT/Home Automation)",
    docsPath: "/channels/mqtt",
    blurb: "Bidirectional messaging via MQTT brokers",
    aliases: ["mosquitto"],
  },

  capabilities: {
    chatTypes: ["direct"],
    supportsMedia: true,
    supportsReactions: false,
    supportsThreads: false,
  },

  // Help framework recognize MQTT targets (fixes "Unknown target" for plugin channels)
  messaging: {
    normalizeTarget: (raw: string): string | undefined => {
      const trimmed = raw.trim();
      if (!trimmed) return undefined;
      // Strip optional "mqtt:" prefix for convenience
      return trimmed.replace(/^mqtt:/i, "") || undefined;
    },
    targetResolver: {
      looksLikeId: (_raw: string, normalized?: string): boolean => {
        // MQTT targets are topic paths (any non-empty string is valid)
        return !!normalized?.trim();
      },
      hint: "<topic-path|senderId>",
    },
  },

  config: {
    listAccountIds: (cfg: any) => {
      return cfg.channels?.mqtt?.brokerUrl ? ["default"] : [];
    },

    resolveAccount: (cfg: any, accountId: any) => {
      const mqtt = cfg.channels?.mqtt;
      if (!mqtt) return { accountId: accountId ?? "default", enabled: false };
      return {
        accountId: accountId ?? "default",
        enabled: mqtt.enabled !== false,
        brokerUrl: mqtt.brokerUrl,
        config: mqtt,
      };
    },

    isEnabled: (account: any) => account.enabled !== false,
    isConfigured: (account: any) => Boolean(account.brokerUrl),
  },

  outbound: {
    deliveryMode: "direct",

    resolveTarget: (params: any) => {
      const to = params?.to ?? params;

      if (!to?.trim()) {
        return { ok: false, error: new Error("MQTT target required") };
      }

      // Normalize: remove mqtt: prefix for processing
      const trimmed = to.trim();
      const withoutPrefix = trimmed.startsWith("mqtt:") ? trimmed.slice(5) : trimmed;

      // If it looks like a senderId (no / character), construct full topic
      if (!withoutPrefix.includes("/")) {
        // Try replyTopicMap first
        const storedTopic = replyTopicMap.get(withoutPrefix);
        if (storedTopic) {
          return { ok: true, to: `mqtt:${storedTopic}` };
        }
        // Fallback: construct topic as senderId/inbound
        return { ok: true, to: `mqtt:${withoutPrefix}/inbound` };
      }

      // Already has /, return with mqtt: prefix
      return { ok: true, to: `mqtt:${withoutPrefix}` };
    },

    async sendText(params: any) {
      const { cfg, to, text, signal } = params;
      if (signal?.aborted) return { ok: false, error: "Aborted" };

      const mqtt = cfg?.channels?.mqtt;
      if (!mqtt?.brokerUrl) return { ok: false, error: "MQTT not configured" };
      if (!mqttClient || !mqttClient.isConnected()) return { ok: false, error: "MQTT not connected" };
      if (!text) return { ok: false, error: "Text required" };

      try {
        const topic = to ?? "openclaw/outbound";
        const senderId = mqtt?.clientId ?? mqttClient?.getClientId() ?? "openclaw";
        const outboundMsg = buildOutboundMessage(senderId, { text });
        const outboundPayload = JSON.stringify(outboundMsg);
        const userProperties = mqttClient.getInitialUserProperties ? mqttClient.getInitialUserProperties() : undefined;
        await mqttClient.publish(topic, outboundPayload, mqtt.qos, userProperties);
        return { ok: true, channel: "mqtt", to: topic };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error };
      }
    },

    async sendMedia(params: any) {
      // Framework may pass target instead of to
      const { cfg, to, target, text, mediaUrl, filePath, media, signal } = params;
      const effectiveTo = to || target;

      if (signal?.aborted) return { ok: false, error: "Aborted" };

      const mqtt = cfg?.channels?.mqtt;
      if (!mqtt?.brokerUrl) return { ok: false, error: "MQTT not configured" };
      if (!mqttClient || !mqttClient.isConnected()) return { ok: false, error: "MQTT not connected" };

      // Support both 'media' (used by framework) and 'mediaUrl'/'filePath' (standard)
      const resolvedPath = media || filePath || mediaUrl;
      if (!resolvedPath) return { ok: false, error: "Media URL or file path is required" };

      try {
        // Support both mediaUrl and filePath (OpenClaw uses filePath)
        const url = media || filePath || mediaUrl;
        const { fileData, fileName: extractedName, fileType, sizeBytes } = extractMediaData({ url, fileName: text });

        if (sizeBytes > MAX_FILE_SIZE_BYTES) {
          return { ok: false, error: `File size exceeds limit. Max: ${MAX_FILE_SIZE_BYTES / (1024 * 1024)}MB, Got: ${(sizeBytes / (1024 * 1024)).toFixed(2)}MB` };
        }

        // Determine topic: use replyTopicMap to find the real reply topic
        let rawTopic = effectiveTo ?? to ?? "openclaw/outbound";

        // If rawTopic looks like a senderId (no / character), look up replyTopicMap
        if (!rawTopic.includes("/")) {
          const mapKey = rawTopic.startsWith("mqtt:") ? rawTopic.slice(5) : rawTopic;
          const storedTopic = replyTopicMap.get(mapKey);
          if (storedTopic) {
            rawTopic = storedTopic;
          }
        }

        const topic = rawTopic.startsWith("mqtt:") ? rawTopic.slice(5) : rawTopic;

        const senderId = mqtt?.clientId ?? mqttClient?.getClientId() ?? "openclaw";
        const outboundMsg = buildOutboundMessage(senderId, {
          type: 'file',
          text,
          fileName: extractedName,
          fileType,
          fileData,
        });

        const outboundPayload = JSON.stringify(outboundMsg);
        const userProperties = mqttClient.getInitialUserProperties ? mqttClient.getInitialUserProperties() : undefined;
        await mqttClient.publish(topic, outboundPayload, mqtt.qos, userProperties);
        return { ok: true, channel: "mqtt", to: topic };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error };
      }
    },
  },

  gateway: {
    startAccount: async (ctx: any) => {
      const { cfg, account, accountId, abortSignal, log } = ctx;

      const mqtt = cfg.channels?.mqtt;
      if (!mqtt?.brokerUrl) {
        log?.debug?.("MQTT channel not configured, skipping");
        return;
      }

      const runtime = getMqttRuntime();

      log?.info?.(`[${accountId}] starting MQTT provider (${mqtt.brokerUrl})`);

      // Create and connect client
      mqttClient = createMqttClient(mqtt, {
        debug: (msg: string) => log?.debug?.(`[MQTT] ${msg}`),
        info: (msg: string) => log?.info?.(`[MQTT] ${msg}`),
        warn: (msg: string) => log?.warn?.(`[MQTT] ${msg}`),
        error: (msg: string) => log?.error?.(`[MQTT] ${msg}`),
      });

      try {
        await mqttClient.connect();
      } catch (err) {
        log?.error?.(`MQTT connection failed (will keep retrying): ${err}`);
      }

      // Subscribe to inbound topic
      const inboundTopic = mqtt.topics?.inbound ?? "openclaw/inbound";
      
      mqttClient.subscribe(inboundTopic, async (topic: string, payload: Buffer, packet: any) => {
        await handleInboundMessage({
          topic,
          payload,
          packet,
          runtime,
          cfg,
          accountId,
          log,
          qos: mqtt.qos,
        });
      });

      log?.info?.(`[${accountId}] MQTT channel ready, subscribed to ${inboundTopic}`);

      // Return a promise that resolves when aborted
      return new Promise<void>((resolve) => {
        const cleanup = () => {
          if (mqttClient) {
            log?.info?.(`[${accountId}] MQTT channel stopping`);
            mqttClient.disconnect().finally(() => {
              mqttClient = null;
              resolve();
            });
          } else {
            resolve();
          }
        };

        if (abortSignal) {
          abortSignal.addEventListener("abort", cleanup, { once: true });
        }
      });
    },
  },

  onboarding: mqttOnboardingAdapter,
};

function generateMessageId(): string {
  return `mqtt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".txt": "text/plain",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".json": "application/json",
    ".zip": "application/zip",
  };
  return map[ext] ?? "application/octet-stream";
}

function extractMediaData(media: { url: string; mimeType?: string; fileName?: string }): {
  fileData: string;
  fileName: string;
  fileType: string;
  sizeBytes: number;
} {
  let fileData: string;
  let fileName = media.fileName ?? "unknown";
  let fileType = media.mimeType ?? "application/octet-stream";

  if (media.url.startsWith("data:")) {
    // data URL format: data:mime;base64,...
    const commaIdx = media.url.indexOf(",");
    if (commaIdx === -1) throw new Error("Invalid data URL format");
    const header = media.url.slice(0, commaIdx);
    fileData = media.url.slice(commaIdx + 1);

    const mimeMatch = header.match(/^data:([^;]+)/);
    if (mimeMatch && !media.mimeType) fileType = mimeMatch[1];
    if (header.includes(";name=")) {
      const nameMatch = header.match(/;name=([^;]+)/);
      if (nameMatch && !media.fileName) fileName = decodeURIComponent(nameMatch[1]);
    }
  } else if (media.url.startsWith("file://")) {
    // file:// URL format
    const filePath = media.url.slice(7);
    const buf = fs.readFileSync(filePath);
    fileData = buf.toString("base64");
    if (!media.mimeType) fileType = getMimeType(filePath);
    if (!media.fileName) fileName = path.basename(filePath);
  } else if (media.url.startsWith("/") || media.url.includes(":\\")) {
    // raw file path format (absolute path)
    const buf = fs.readFileSync(media.url);
    fileData = buf.toString("base64");
    if (!media.mimeType) fileType = getMimeType(media.url);
    if (!media.fileName) fileName = path.basename(media.url);
  } else {
    // treat as raw base64 string
    fileData = media.url;
  }

  const sizeBytes = Math.floor((fileData.length * 3) / 4);
  return { fileData, fileName, fileType, sizeBytes };
}

function buildOutboundMessage(senderId: string, opts: {
  text?: string;
  type?: 'text' | 'file';
  fileName?: string;
  fileType?: string;
  fileData?: string;
  targetIds?: string[];
}): MqttMessage {
  return {
    id: generateMessageId(),
    senderId,
    text: opts.text,
    timestamp: new Date(),
    type: opts.type ?? 'text',
    ...(opts.fileName ? { fileName: opts.fileName } : {}),
    ...(opts.fileType ? { fileType: opts.fileType } : {}),
    ...(opts.fileData ? { fileData: opts.fileData } : {}),
    ...(opts.targetIds ? { targetIds: opts.targetIds } : {}),
  };
}

/**
 * Handle inbound MQTT group message - process through OpenClaw agent and deliver reply
 */
async function handleGroupMessage(opts: {
  topic: string;
  groupTopic: string;
  payload: Buffer;
  packet: any;
  runtime: any;
  cfg: any;
  accountId: string;
  log: any;
  qos: number;
}) {
  const { topic, groupTopic, payload, packet, runtime, cfg, accountId, log, qos } = opts;

  try {
    const text = payload.toString("utf-8");
    log?.info?.(`Inbound MQTT group message on ${topic} (group: ${groupTopic}): ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);

    const mySenderId = mqttClient?.getClientId() || "openclaw";

    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text);
    } catch {
      parsedPayload = null;
    }

    let msg: MqttMessage | null = null;
    if (parsedPayload && parsedPayload.senderId) {
      msg = parsedPayload as unknown as MqttMessage;
    }

    let messageBody: string;
    let senderId: string;
    let senderName: string;
    let messageType: string = "text";
    let fileMedia: Array<{ url: string; mimeType?: string; fileName?: string }> | undefined;
    let shouldReply = true;
    let msgHadTargetIds = false;

    if (msg) {
      senderId = msg.senderId;
      senderName = packet?.properties?.userProperties?.name as string || senderId;

      if (senderId === mySenderId) {
        log?.debug?.(`MQTT: ignoring self-sent message from ${senderId}`);
        return;
      }

      msgHadTargetIds = !!(msg.targetIds && msg.targetIds.length > 0);
      // Track group membership for session cleanup
      if (!groupMembersMap.has(groupTopic)) {
        groupMembersMap.set(groupTopic, new Set());
      }
      groupMembersMap.get(groupTopic)!.add(senderId);
      log?.info?.(`MQTT group msg: senderId=${senderId}, msgHadTargetIds=${msgHadTargetIds}, targetIds=${JSON.stringify(msg.targetIds)}`);
      if (msgHadTargetIds) {
        const myClientId = mqttClient?.getClientId() || "openclaw";
        if (!msg.targetIds!.some(id => id.includes(myClientId))) {
          log?.info?.(`MQTT: targetIds not meant for client '${myClientId}', will record context without reply`);
          shouldReply = false;
        }
      }

      messageType = msg.type ?? "text";
      if (messageType === "file") {
        const fileName = msg.fileName ?? "unknown";
        const fileType = msg.fileType ?? "application/octet-stream";
        messageBody = msg.text ?? `[File: ${fileName} (${fileType})]`;

        if (msg.fileData) {
          const dataUrl = `data:${fileType};base64,${msg.fileData}`;
          fileMedia = [{ url: dataUrl, mimeType: fileType, fileName }];
        }
      } else {
        messageBody = msg.text ?? "";
      }
    } else {
      messageBody = text;
      senderId = topic.replace(/\//g, "-");
      senderName = senderId;
    }

    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: messageBody,
      RawBody: text,
      CommandBody: messageBody,
      CommandAuthorized: true,
      From: `mqtt:${senderId}`,
      To: `mqtt:${groupTopic}`,  // group message: use groupTopic as reply target
      SessionKey: `agent:main:mqtt:${senderId}`,
      AccountId: accountId,
      ChatType: "direct",
      ConversationLabel: `mqtt:group:${groupTopic}`,
      SenderName: senderId,
      SenderId: senderId,
      Provider: "mqtt",
      Surface: "mqtt",
      MessageSid: msg?.id ?? generateMessageId(),
      Timestamp: msg?.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      ...(fileMedia ? { Media: fileMedia } : {}),
    });

    // inbound context logging removed

    // Dispatch through OpenClaw's reply system and publish replies
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
          deliver: async (payload: { text?: string; media?: any }, info: { kind: string }) => {
           if (!shouldReply) {
             log?.info?.(`MQTT: skipping reply for non-targeted message (context only)`);
             return;
           }
           if (!payload.text && !payload.media) {
            log?.debug?.(`MQTT: skipping empty ${info.kind} group reply`);
            return;
          }

          if (mqttClient?.isConnected()) {
            try {
              const myId = mqttClient.getClientId() || "openclaw";
              const outOpts: Parameters<typeof buildOutboundMessage>[1] = {
                text: payload.text,
              };

              if (msgHadTargetIds) {
                outOpts.text = `@${senderName} ${payload.text ?? ""}`.trim();
                outOpts.targetIds = [senderId];
                log?.info?.(`MQTT group reply: prepended @${senderName}, targetIds=[${senderId}] because original msg had targetIds`);
              }

              if (payload.media) {
                outOpts.type = 'file';
                outOpts.fileName = payload.media.fileName;
                outOpts.fileType = payload.media.mimeType;
                outOpts.fileData = typeof payload.media.url === 'string' && payload.media.url.startsWith('data:')
                  ? payload.media.url.split(',')[1]
                  : payload.media.url;
              }

              const outboundPayload = JSON.stringify(buildOutboundMessage(myId, outOpts));
              log?.info?.(`MQTT group reply payload: ${outboundPayload}`);

              const userProperties = {
                ...mqttClient.getInitialUserProperties(),
                reply_to: groupTopic,
              };
              await mqttClient.publish(groupTopic, outboundPayload, qos as 0 | 1 | 2, userProperties);
              log?.info?.(`MQTT: sent group reply to ${groupTopic}`);
            } catch (err) {
              log?.error?.(`MQTT: failed to send group reply: ${err}`);
            }
          } else {
            log?.warn?.(`MQTT: not connected, cannot send group reply`);
          }
        },
        onSkip: (_payload: any, info: { reason: string }) => {
          log?.debug?.(`MQTT: skipped group reply (${info.reason})`);
        },
        onError: (err: Error, info: { kind: string }) => {
          log?.error?.(`MQTT: ${info.kind} group reply error: ${err}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
      },
    });

    // dispatch complete

    log?.info?.(`MQTT group message processed from ${senderId} in group ${groupTopic}`);
  } catch (err) {
    log?.error?.(`Failed to process MQTT group message: ${err}`);
  }
}

/**
 * Handle inbound MQTT message - process through OpenClaw agent and deliver reply
 */
async function handleInboundMessage(opts: {
  topic: string;
  payload: Buffer;
  packet: any;
  runtime: any;
  cfg: any;
  accountId: string;
  log: any;
  qos: number;
}) {
  const { topic, payload, packet, runtime, cfg, accountId, log, qos } = opts;

  try {
    const text = payload.toString("utf-8");
    log?.info?.(`Inbound MQTT message on ${topic}: ${text.slice(0, 200)}${text.length > 200 ? "..." : ""}`);

    // Get my own senderId for filtering self-sent messages
    const mySenderId = mqttClient?.getClientId() || "openclaw";

    // Determine reply topic from user properties (for MQTT v5.0)
    // replyTopic stores a plain topic path (no "mqtt:" prefix)
    let replyTopic = "openclaw/outbound"; // Default fallback (plain topic path)
    if (packet && packet.properties && packet.properties.userProperties) {
      const userProps = packet.properties.userProperties;
      if (userProps.reply_to) {
        replyTopic = userProps.reply_to; // plain topic path from userProperties
      } else {
        log?.warn?.('MQTT v5.0 message missing required "reply_to" property in userProperties, using default reply topic');
      }
    } else {
      log?.warn?.('MQTT message missing properties or userProperties, using default reply topic');
    }

    // Parse JSON and attempt MqttMessage format
    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text);
    } catch {
      parsedPayload = null;
    }

    let msg: MqttMessage | null = null;
    let messageKind: string | undefined;
    if (parsedPayload) {
      messageKind = parsedPayload.kind as string;
      if (parsedPayload.senderId) {
        msg = parsedPayload as unknown as MqttMessage;
      }
    }

    log?.info?.(`MQTT: parsed payload, msg=${msg !== null}, senderId=${parsedPayload?.senderId ?? "(none)"}, kind=${messageKind ?? "(none)"}`);

    // Handle control messages regardless of senderId presence
    if (messageKind === "invite") {
      const groupTopic = (parsedPayload?.topic as string) ?? topic;
      log?.info?.(`MQTT: invite message for group ${groupTopic}`);

      log?.info?.(`MQTT invite: joining group ${groupTopic}`);

      if (mqttClient?.isConnected()) {
        try {
          mqttClient.subscribe(groupTopic, async (t: string, gPayload: Buffer, pkt: any) => {
            await handleGroupMessage({
              topic: t,
              groupTopic: groupTopic,
              payload: gPayload,
              packet: pkt,
              runtime,
              cfg,
              accountId,
              log,
              qos: qos,
            });
          });
          log?.info?.(`MQTT: subscribed to group ${groupTopic}`);

          const acceptMsg = buildOutboundMessage(mqttClient.getClientId() || "openclaw", {
            text: "invite accepted",
          });
          const acceptPayload = JSON.stringify({ ...acceptMsg, kind: "accept" });
          await mqttClient.publish(groupTopic, acceptPayload, qos as 0 | 1 | 2, mqttClient.getInitialUserProperties());
          log?.info?.(`MQTT: sent invite accepted to ${groupTopic}`);
        } catch (err) {
          log?.error?.(`MQTT: failed to process invite: ${err}`);
        }
      }

      log?.info?.(`MQTT invite processed for ${groupTopic}`);
      return;
    }

    if (messageKind === "dismissed") {
      log?.info?.(`MQTT: received dismiss message, raw payload: ${text}`);
      log?.info?.(`MQTT: parsedPayload: ${JSON.stringify(parsedPayload)}`);
      log?.info?.(`MQTT: messageKind=${messageKind}, topic=${topic}`);

      const groupTopic = (parsedPayload?.topic as string) ?? topic;
      log?.info?.(`MQTT: resolved groupTopic=${groupTopic}, mqttClient connected=${mqttClient?.isConnected()}`);

      if (mqttClient?.isConnected()) {
        log?.info?.(`MQTT: attempting to unsubscribe from ${groupTopic}`);
        try {
          // Notify group before leaving
          const leaveMsg = buildOutboundMessage(mqttClient.getClientId() || "openclaw", {
            text: "bot left the group",
          });
          const leavePayload = JSON.stringify({ ...leaveMsg, kind: "bye" });
          await mqttClient.publish(groupTopic, leavePayload, qos as 0 | 1 | 2, mqttClient.getInitialUserProperties());

          mqttClient.unsubscribe(groupTopic, (err) => {
            if (err) {
              log?.error?.(`MQTT: failed to unsubscribe from group ${groupTopic}: ${err?.message}`);
            } else {
              log?.info?.(`MQTT: unsubscribed from group ${groupTopic}`);
            }
          });
          log?.info?.(`MQTT: unsubscribe call completed for ${groupTopic}`);
        } catch (err) {
          log?.error?.(`MQTT: failed to process dismiss: ${err}`);
        }
      } else {
        log?.info?.(`MQTT: not connected, skipping unsubscribe for ${groupTopic}`);
      }

      log?.info?.(`MQTT dismiss processed for ${groupTopic}`);

      // Clean up local state for this group
      const members = groupMembersMap.get(groupTopic);
      if (members) {
        log?.info?.(`MQTT: cleaning up ${members.size} group member local state for ${groupTopic}`);
        for (const memberId of members) {
          replyTopicMap.delete(memberId);
        }
        groupMembersMap.delete(groupTopic);
      }

      log?.info?.(`MQTT: group cleanup complete for ${groupTopic}`);
      return;
    }

    let messageBody: string;
    let senderId: string;
    let messageType: string = "text";
    let fileMedia: Array<{ url: string; mimeType?: string; fileName?: string }> | undefined;
    let shouldReply = true;

    if (msg) {
      senderId = msg.senderId;

      if (senderId === mySenderId) {
        log?.info?.(`MQTT: ignoring self-sent message from ${senderId}`);
        return;
      }

      if (msg.targetIds && msg.targetIds.length > 0) {
        const myClientId = mqttClient?.getClientId() || "openclaw";
        if (!msg.targetIds.some(id => id.includes(myClientId))) {
          log?.info?.(`MQTT: targetIds not meant for client '${myClientId}', will record context without reply`);
          shouldReply = false;
        }
      }

      // Regular message: extract by type
      messageType = msg.type ?? "text";
      if (messageType === "file") {
        const fileName = msg.fileName ?? "unknown";
        const fileType = msg.fileType ?? "application/octet-stream";
        messageBody = msg.text ?? `[File: ${fileName} (${fileType})]`;

        if (msg.fileData) {
          const dataUrl = `data:${fileType};base64,${msg.fileData}`;
          fileMedia = [{ url: dataUrl, mimeType: fileType, fileName }];
        }
      } else {
        messageBody = msg.text ?? "";
      }
    } else {
      // Legacy plain text fallback
      messageBody = text;
      senderId = topic.replace(/\//g, "-");
    }

    // Store replyTopic BEFORE dispatchReply so resolveTarget can find it
    replyTopicMap.set(senderId, replyTopic);

    // Build the inbound context using OpenClaw's standard format
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: messageBody,
      RawBody: text,
      CommandBody: messageBody,
      CommandAuthorized: true,
      From: `mqtt:${senderId}`,
      To: `mqtt:${replyTopic}`,  // 使用 replyTopic，框架会把它作为 to 传给 sendMedia
      SessionKey: `agent:main:mqtt:${senderId}`,
      AccountId: accountId,
      ChatType: "direct",
      ConversationLabel: `mqtt:${senderId}`,
      SenderName: senderId,
      SenderId: senderId,
      Provider: "mqtt",
      Surface: "mqtt",
      MessageSid: msg?.id ?? generateMessageId(),
      Timestamp: msg?.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      ...(fileMedia ? { Media: fileMedia } : {}),
    });

    // Dispatch through OpenClaw's reply system and publish replies
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; media?: any }, info: { kind: string }) => {
           if (!shouldReply) {
             log?.info?.(`MQTT: skipping reply for non-targeted group message (context only)`);
             return;
           }
          if (!payload.text && !payload.media) {
            log?.debug?.(`MQTT: skipping empty ${info.kind} reply`);
            return;
          }

          if (mqttClient?.isConnected()) {
            try {
              const myId = mqttClient.getClientId() || "openclaw";
              const outOpts: Parameters<typeof buildOutboundMessage>[1] = {
                text: payload.text,
              };

              if (payload.media) {
                outOpts.type = 'file';
                const { fileData, fileName: extractedName, fileType } = extractMediaData({
                  url: payload.media.url,
                  fileName: payload.media.fileName,
                  mimeType: payload.media.mimeType,
                });
                outOpts.fileName = extractedName;
                outOpts.fileType = fileType;
                outOpts.fileData = fileData;
              }

              const outboundPayload = JSON.stringify(buildOutboundMessage(myId, outOpts));

              const userProperties = {
                ...mqttClient.getInitialUserProperties(),
                reply_to: replyTopic,
              };
              await mqttClient.publish(replyTopic, outboundPayload, qos as 0 | 1 | 2, userProperties);
              log?.info?.(`MQTT: sent reply to ${replyTopic}`);
            } catch (err) {
              log?.error?.(`MQTT: failed to send reply: ${err}`);
            }
          } else {
            log?.warn?.(`MQTT: not connected, cannot send reply`);
          }
        },
        onSkip: (_payload: any, info: { reason: string }) => {
          log?.debug?.(`MQTT: skipped reply (${info.reason})`);
        },
        onError: (err: Error, info: { kind: string }) => {
          log?.error?.(`MQTT: ${info.kind} reply error: ${err}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
      },
    });

    // dispatch complete
    log?.info?.(`MQTT message processed from ${senderId}`);
    log?.info?.(`MQTT: stored replyTopic ${replyTopic} for sender ${senderId}`);
  } catch (err) {
    log?.error?.(`Failed to process MQTT message: ${err}`);
  }
}


