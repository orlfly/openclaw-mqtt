import type { ChannelPlugin } from "openclaw/plugin-sdk";
import type { MqttCoreConfig } from "./types.js";
import { createMqttClient, MqttClientManager } from "./client.js";
import { mqttOnboardingAdapter } from "./onboarding.js";
import { getMqttRuntime } from "./runtime.js";

// Global client instance (one per gateway lifecycle)
let mqttClient: MqttClientManager | null = null;

// Track joined group topics for group chat
const joinedGroups: Set<string> = new Set();

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
    supportsMedia: false,
    supportsReactions: false,
    supportsThreads: false,
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

    async sendText({ text, cfg }: { text: string; cfg: any }) {
      const mqtt = cfg.channels?.mqtt;
      if (!mqtt?.brokerUrl) {
        return { ok: false, error: "MQTT not configured" };
      }

      if (!mqttClient || !mqttClient.isConnected()) {
        return { ok: false, error: "MQTT not connected" };
      }

      try {
        // For outbound messages initiated by the system (not in response to an inbound message),
        // use the default outbound topic
        const topic = "openclaw/outbound";
        const senderId = mqttClient.getClientId() || "openclaw";
        const outboundPayload = JSON.stringify({
          senderId,
          text,
          ts: Date.now(),
        });
        // For outbound messages, use connection's initial user properties if available
        const userProperties = mqttClient.getInitialUserProperties ? mqttClient.getInitialUserProperties() : undefined;
        await mqttClient.publish(topic, outboundPayload, mqtt.qos, userProperties);
        return { ok: true };
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

    // Get my own senderId for filtering self-sent messages
    const mySenderId = mqttClient?.getClientId() || "openclaw";

    // Parse JSON if possible to extract structured data
    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text);
    } catch {
      parsedPayload = null;
    }

    // Extract message body and sender from payload
    let messageBody: string;
    let senderId: string;
    let correlationId: string | undefined;

    if (parsedPayload && typeof parsedPayload === "object") {
      messageBody =
        (parsedPayload.message as string) ??
        (parsedPayload.text as string) ??
        (parsedPayload.msg as string) ??
        (parsedPayload.alert as string) ??
        (parsedPayload.body as string) ??
        text;

      senderId =
        (parsedPayload.senderId as string) ??
        (parsedPayload.source as string) ??
        (parsedPayload.sender as string) ??
        (parsedPayload.from as string) ??
        (parsedPayload.service as string) ??
        topic.replace(/\//g, "-");

      correlationId =
        (parsedPayload.correlationId as string) ??
        (parsedPayload.requestId as string) ??
        undefined;

      // Filter out messages sent by ourselves
      if (senderId === mySenderId) {
        log?.debug?.(`MQTT: ignoring self-sent message from ${senderId}`);
        return;
      }

      // Check targetIds attribute if it exists - ignore messages not targeting this client
      if (parsedPayload.targetIds) {
        const targetIds = parsedPayload.targetIds as string[] | string;
        const myClientId = mqttClient?.getClientId() || "openclaw";
        
        // Convert to array if it's a single string
        const targetsArray = Array.isArray(targetIds) ? targetIds : [targetIds];
        
        // If targetIds doesn't contain my client ID, ignore the message
        if (!targetsArray.some(id => id.includes(myClientId))) {
          log?.debug?.(`MQTT: ignoring message with targetIds '${JSON.stringify(targetsArray)}' not meant for client '${myClientId}'`);
          return;
        }
      }
    } else {
      messageBody = text;
      senderId = topic.replace(/\//g, "-");
    }

    // Build the inbound context using OpenClaw's standard format
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: messageBody,
      RawBody: text,
      CommandBody: messageBody,
      CommandAuthorized: true,
      From: `mqtt:${senderId}`,
      To: `mqtt:${accountId}`,
      SessionKey: `agent:main:mqtt:${senderId}`, // Using senderId to maintain session per sender within group
      AccountId: accountId,
      ChatType: "direct",
      ConversationLabel: `mqtt:group:${groupTopic}`, // Group-specific conversation label
      SenderName: senderId,
      SenderId: senderId,
      Provider: "mqtt",
      Surface: "mqtt",
      MessageSid: `mqtt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Timestamp: Date.now(),
    });

    // inbound context logging removed

    // Dispatch through OpenClaw's reply system and publish replies
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; media?: any }, info: { kind: string }) => {
          if (!payload.text) {
            log?.debug?.(`MQTT: skipping empty ${info.kind} reply`);
            return;
          }

          log?.info?.(`MQTT group reply (${info.kind}) [${payload.text.length} chars]`);

           if (mqttClient?.isConnected()) {
            try {
              const senderId = mqttClient.getClientId() || "openclaw";
              const outboundPayload = JSON.stringify({
                senderId,
                text: payload.text,
                kind: info.kind,
                ts: Date.now(),
                ...(correlationId ? { correlationId } : {}),
              });
              
              // For group messages, reply to the same group topic
              const userProperties = {
                ...mqttClient.getInitialUserProperties(), // Include connection-time user properties
                reply_to: groupTopic, // Reply to the group topic
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
    let replyTopic = "openclaw/outbound"; // Default fallback
    if (packet && packet.properties && packet.properties.userProperties) {
      const userProps = packet.properties.userProperties;
      if (userProps.reply_to) {
        replyTopic = userProps.reply_to;
      } else {
        log?.warn?.('MQTT v5.0 message missing required "reply_to" property in userProperties, using default reply topic');
      }
    } else {
      log?.warn?.('MQTT message missing properties or userProperties, using default reply topic');
    }

    // Parse JSON if possible to extract structured data
    let parsedPayload: Record<string, unknown> | null = null;
    try {
      parsedPayload = JSON.parse(text);
    } catch {
      parsedPayload = null;
    }

    // Extract message body and sender from payload
    let messageBody: string;
    let senderId: string;
    let correlationId: string | undefined;

    if (parsedPayload && typeof parsedPayload === "object") {
      messageBody =
        (parsedPayload.message as string) ??
        (parsedPayload.text as string) ??
        (parsedPayload.msg as string) ??
        (parsedPayload.alert as string) ??
        (parsedPayload.body as string) ??
        text;

      senderId =
        (parsedPayload.senderId as string) ??
        (parsedPayload.source as string) ??
        (parsedPayload.sender as string) ??
        (parsedPayload.from as string) ??
        (parsedPayload.service as string) ??
        topic.replace(/\//g, "-");

      correlationId =
        (parsedPayload.correlationId as string) ??
        (parsedPayload.requestId as string) ??
        undefined;

      // Filter out messages sent by ourselves
      if (senderId === mySenderId) {
        log?.debug?.(`MQTT: ignoring self-sent message from ${senderId}`);
        return;
      }

      // Handle group chat invite messages
      const messageKind = (parsedPayload?.kind as string) ?? "direct";
      if (messageKind === "invite" && parsedPayload) {
        const groupTopic = (parsedPayload.topic as string) ?? topic;
        
        // Check if already joined
        if (joinedGroups.has(groupTopic)) {
          log?.debug?.(`MQTT: already joined group ${groupTopic}, skipping invite`);
          return;
        }
        
        joinedGroups.add(groupTopic);
        log?.info?.(`MQTT invite: joining group ${groupTopic}`);

        if (mqttClient?.isConnected()) {
          try {
            // Subscribe to the group topic - use handleGroupMessage for group messages
            mqttClient.subscribe(groupTopic, async (t: string, payload: Buffer, pkt: any) => {
              await handleGroupMessage({
                topic: t,
                groupTopic: groupTopic,
                payload,
                packet: pkt,
                runtime,
                cfg,
                accountId,
                log,
                qos: qos,
              });
            });
            log?.info?.(`MQTT: subscribed to group ${groupTopic}`);

            // Send "invite accepted" message to the group topic
            const senderId = mqttClient.getClientId() || "openclaw";
            const acceptPayload = JSON.stringify({
              senderId,
              text: "invite accepted",
              kind: "accept",
              ts: Date.now(),
            });
            const userProperties = {
              ...mqttClient.getInitialUserProperties(),
            };
            await mqttClient.publish(groupTopic, acceptPayload, qos as 0 | 1 | 2, userProperties);
            log?.info?.(`MQTT: sent invite accepted to ${groupTopic}`);
          } catch (err) {
            log?.error?.(`MQTT: failed to process invite: ${err}`);
          }
        }

        log?.info?.(`MQTT invite processed for ${groupTopic}`);
        return;
      }
      
      // Handle group chat dismissed messages
      if (messageKind === "dismissed" && parsedPayload) {
        const groupTopic = (parsedPayload.topic as string) ?? topic;
        
        // Check if we've joined this group
        if (!joinedGroups.has(groupTopic)) {
          log?.debug?.(`MQTT: not member of group ${groupTopic}, skipping dismiss message`);
          return;
        }
        
        joinedGroups.delete(groupTopic);
        log?.info?.(`MQTT: removing from group ${groupTopic} (dismissed by admin)`);
        
        if (mqttClient?.isConnected()) {
          try {
            // Unsubscribe from the group topic
            mqttClient.unsubscribe(groupTopic, (err) => {
              if (err) {
                log?.error?.(`MQTT: failed to unsubscribe from group ${groupTopic}: ${err?.message}`);
              } else {
                log?.info?.(`MQTT: unsubscribed from group ${groupTopic}`);
              }
            });
          } catch (err) {
            log?.error?.(`MQTT: failed to process dismiss: ${err}`);
          }
        }
        
        log?.info?.(`MQTT dismiss processed for ${groupTopic}`);
        return;
      }
    } else {
      messageBody = text;
      senderId = topic.replace(/\//g, "-");
    }

    // Build the inbound context using OpenClaw's standard format
    const ctxPayload = runtime.channel.reply.finalizeInboundContext({
      Body: messageBody,
      RawBody: text,
      CommandBody: messageBody,
      CommandAuthorized: true,
      From: `mqtt:${senderId}`,
      To: `mqtt:${accountId}`,
      SessionKey: `agent:main:mqtt:${senderId}`,
      AccountId: accountId,
      ChatType: "direct",
      ConversationLabel: `mqtt:${senderId}`,
      SenderName: senderId,
      SenderId: senderId,
      Provider: "mqtt",
      Surface: "mqtt",
      MessageSid: `mqtt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      Timestamp: Date.now(),
    });

    // inbound context logging removed

    // Dispatch through OpenClaw's reply system and publish replies
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string; media?: any }, info: { kind: string }) => {
          if (!payload.text) {
            log?.debug?.(`MQTT: skipping empty ${info.kind} reply`);
            return;
          }

          log?.info?.(`MQTT reply (${info.kind}) [${payload.text.length} chars]`);

           if (mqttClient?.isConnected()) {
            try {
              const senderId = mqttClient.getClientId() || "openclaw";
              const outboundPayload = JSON.stringify({
                senderId,
                text: payload.text,
                kind: info.kind,
                ts: Date.now(),
                ...(correlationId ? { correlationId } : {}),
              });
              
              // Combine initial user properties with reply_to property
              const userProperties = {
                ...mqttClient.getInitialUserProperties(), // Include connection-time user properties
                reply_to: replyTopic, // Add reply_to property
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
  } catch (err) {
    log?.error?.(`Failed to process MQTT message: ${err}`);
  }
}


