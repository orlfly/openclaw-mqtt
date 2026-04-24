import { z } from "zod";

/**
 * MQTT Configuration Schema
 *
 * Values can come from:
 * 1. ~/.openclaw/openclaw.json (channels.mqtt.*)
 * 2. Environment variables (MQTT_*)
 *
 * Environment variables take precedence for secrets.
 */
export const mqttConfigSchema = z.object({
  // Connection - env: MQTT_BROKER_URL
  brokerUrl: z.string().url().describe("MQTT broker URL"),
  // Auth - env: MQTT_USERNAME, MQTT_PASSWORD (recommended for secrets)
  username: z.string().optional().describe("Broker username"),
  password: z.string().optional().describe("Broker password"),
  // Client - env: MQTT_CLIENT_ID
  clientId: z.string().optional().describe("MQTT client ID"),
  // Protocol - env: MQTT_PROTOCOL_VERSION
  protocolVersion: z.literal(5).default(5).describe("MQTT protocol version (only v5.0 supported)"),
  // User properties - env: MQTT_USER_PROPERTIES
  userProperties: z.record(z.string(), z.string()).optional().describe("User properties to send with connection"),
  topics: z
    .object({
      inbound: z.string().default("openclaw/inbound"),
      // Outbound is no longer used as replies use send_back from incoming messages
    })
    .default({}),
  qos: z.union([z.literal(0), z.literal(1), z.literal(2)]).default(1),
  tls: z
    .object({
      enabled: z.boolean().default(false),
      rejectUnauthorized: z.boolean().default(true),
      ca: z.string().optional(),
    })
    .optional(),
});

export type MqttConfig = z.infer<typeof mqttConfigSchema>;

export const defaultConfig: Partial<MqttConfig> = {
  topics: {
    inbound: "openclaw/inbound",
  },
  qos: 1,
};
