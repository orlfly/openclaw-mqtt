import type { MqttConfig } from "./config-schema.js";

/**
 * Environment variable names for MQTT config.
 * These override values from openclaw.json for sensitive data.
 */
export const ENV_VARS = {
  BROKER_URL: "MQTT_BROKER_URL",
  USERNAME: "MQTT_USERNAME",
  PASSWORD: "MQTT_PASSWORD",
  CLIENT_ID: "MQTT_CLIENT_ID",
  PROTOCOL_VERSION: "MQTT_PROTOCOL_VERSION",
  USER_PROPERTIES: "MQTT_USER_PROPERTIES",
  CA_PATH: "MQTT_CA_PATH",
} as const;

/**
 * Merge config from openclaw.json with environment variables.
 * Environment variables take precedence (recommended for secrets).
 */
export function mergeWithEnv(config: Partial<MqttConfig>): MqttConfig {
  // Parse user properties from environment variable if provided
  let userPropertiesFromEnv: Record<string, string> | undefined;
  if (process.env[ENV_VARS.USER_PROPERTIES]) {
    try {
      userPropertiesFromEnv = JSON.parse(process.env[ENV_VARS.USER_PROPERTIES]!);
    } catch (e) {
      console.error('Invalid JSON in MQTT_USER_PROPERTIES environment variable');
    }
  }

  return {
    brokerUrl: process.env[ENV_VARS.BROKER_URL] ?? config.brokerUrl ?? "",
    protocolVersion: parseInt(process.env[ENV_VARS.PROTOCOL_VERSION] || '5') as 5, // Only support v5.0
    userProperties: userPropertiesFromEnv ?? config.userProperties,
    username: process.env[ENV_VARS.USERNAME] ?? config.username,
    password: process.env[ENV_VARS.PASSWORD] ?? config.password,
    clientId: process.env[ENV_VARS.CLIENT_ID] ?? config.clientId,
    topics: config.topics ?? {
      inbound: "openclaw/inbound",
    },
    qos: config.qos ?? 1,
    tls: config.tls
      ? {
          ...config.tls,
          ca: process.env[ENV_VARS.CA_PATH] ?? config.tls.ca,
        }
      : undefined,
  };
}
