import mqtt, { MqttClient, IClientOptions } from "mqtt";
import type { MqttConfig } from "./config-schema.js";
import { mergeWithEnv } from "./env.js";

export interface MqttClientManager {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  publish(topic: string, message: string, qos?: 0 | 1 | 2, userProperties?: Record<string, string>): Promise<void>;
  subscribe(topic: string, handler: MessageHandler): void;
  isConnected(): boolean;
  getInitialUserProperties(): Record<string, string> | undefined;
  getClientId(): string | undefined;
}

export type MessageHandler = (topic: string, payload: Buffer, packet?: any) => void;

interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const DEFAULT_RECONNECT_MS = 5000;
const MAX_RECONNECT_MS = 60000;
const INITIAL_CONNECT_GRACE_MS = 5000;
const RECONNECT_JITTER = 0.2;

/**
 * MQTT Client Manager
 * 
 * Handles connection lifecycle, reconnection, and message routing.
 */
export function createMqttClient(
  rawConfig: Partial<MqttConfig>,
  logger: Logger
): MqttClientManager {
  const config = mergeWithEnv(rawConfig);
  let client: MqttClient | null = null;
  let messageHandlers: Map<string, MessageHandler[]> = new Map();
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectPromise: Promise<void> | null = null;
  let manualDisconnect = false;
  const initialUserProperties = { ...config.userProperties }; // Save initial user properties

  function getClientOptions(): IClientOptions {
    const options: IClientOptions = {
      clientId: config.clientId ?? `openclaw-${Math.random().toString(36).slice(2, 10)}`,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 0,
      protocolVersion: config.protocolVersion,
    };

    // Auth
    if (config.username) {
      options.username = config.username;
    }
    if (config.password) {
      options.password = config.password;
    }

    // User Properties (MQTT v5.0)
    if (config.userProperties && Object.keys(config.userProperties).length > 0) {
      options.properties = {
        ...options.properties,
        userProperties: config.userProperties,
      };
    }

    // TLS
    if (config.tls?.enabled) {
      options.rejectUnauthorized = config.tls.rejectUnauthorized ?? true;
      if (config.tls.ca) {
        // Note: In production, read the CA file
        // options.ca = fs.readFileSync(config.tls.ca);
      }
    }

    return options;
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function getBackoffDelay(attempt: number): number {
    const base = Math.min(
      DEFAULT_RECONNECT_MS * Math.pow(2, Math.max(0, attempt - 1)),
      MAX_RECONNECT_MS
    );
    const jitter = base * RECONNECT_JITTER * Math.random();
    return Math.round(base + jitter);
  }

  function scheduleReconnect(reason: string) {
    if (manualDisconnect) return;
    if (reconnectTimer) return;

    reconnectAttempts += 1;
    const delay = getBackoffDelay(reconnectAttempts);

    logger.warn(`MQTT reconnect scheduled in ${delay}ms (${reason})`);

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (manualDisconnect) return;

      if (!client) {
        connect().catch((err) => logger.error(`MQTT reconnect failed: ${err}`));
        return;
      }

      try {
        logger.info("MQTT reconnecting...");
        client.reconnect();
      } catch (err) {
        logger.error(`MQTT reconnect error: ${err}`);
        scheduleReconnect("reconnect error");
      }
    }, delay);
  }

  function attachClientHandlers(activeClient: MqttClient) {
    activeClient.on("connect", (connack: any) => {
      logger.info("MQTT connected");
      
      // Check broker protocol version
      if (config.protocolVersion === 5) {
        if (connack && typeof connack === 'object') {
          logger.info(`MQTT 5.0 broker connected (Reason code: ${connack.reasonCode || 'unknown'})`);
          
          // If the connack has properties specific to MQTT 5.0, confirm the version
          if (connack.properties) {
            logger.debug("MQTT 5.0 properties received from broker");
          }
        } else {
          logger.info("MQTT 5.0 connection established");
        }
      } else {
        logger.warn(`Expected MQTT 5.0 but protocol version is ${config.protocolVersion}`);
      }
      
      reconnectAttempts = 0;
      clearReconnectTimer();

      // Resubscribe to all topics
      for (const topic of messageHandlers.keys()) {
        activeClient.subscribe(topic, { qos: config.qos }, (err: Error | null) => {
          if (err) {
            logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
          } else {
            logger.debug(`Subscribed to ${topic}`);
          }
        });
      }
    });

      activeClient.on("message", (topic: string, payload: Buffer, packet: any) => {
        logger.debug(`Received message on ${topic}: ${payload.length} bytes`);
        const handlers = [...(messageHandlers.get(topic) ?? [])];

        // Also check wildcard subscriptions (skip exact match to avoid duplicates)
        for (const [pattern, patternHandlers] of messageHandlers) {
          if (pattern === topic) continue;
          if (topicMatches(pattern, topic)) {
            handlers.push(...patternHandlers);
          }
        }

        for (const handler of handlers) {
          try {
            // Pass the packet properties (including userProperties) to the handler
            handler(topic, payload, packet);
          } catch (err) {
            logger.error(`Message handler error: ${err}`);
          }
        }
      });

      activeClient.on("error", (err: Error) => {
        logger.error(`MQTT error: ${err.message}`);
        scheduleReconnect("error");
      });

      activeClient.on("close", () => {
        logger.warn("MQTT connection closed");
        scheduleReconnect("close");
      });

      activeClient.on("reconnect", () => {
        logger.info("MQTT reconnect event");
      });

      activeClient.on("offline", () => {
        logger.warn("MQTT client offline");
        scheduleReconnect("offline");
      });
  }

  async function connect(): Promise<void> {
    if (client?.connected) {
      logger.debug("MQTT already connected");
      return;
    }

    if (connectPromise) {
      return connectPromise;
    }

    manualDisconnect = false;

    if (!client) {
      logger.info(`Connecting to MQTT broker: ${config.brokerUrl}`);

      const options = getClientOptions();
      client = mqtt.connect(config.brokerUrl, options);
      attachClientHandlers(client);
    } else {
      logger.info("MQTT connect requested; reconnecting existing client");
      try {
        client.reconnect();
      } catch (err) {
        logger.error(`MQTT reconnect error: ${err}`);
        scheduleReconnect("reconnect error");
      }
    }

    connectPromise = new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        connectPromise = null;
        resolve();
      };

      if (client?.connected) {
        settle();
        return;
      }

      const timer = setTimeout(() => {
        logger.warn(
          `MQTT initial connect not ready after ${INITIAL_CONNECT_GRACE_MS}ms; continuing retries in background`
        );
        settle();
      }, INITIAL_CONNECT_GRACE_MS);

      client?.once("connect", () => {
        clearTimeout(timer);
        settle();
      });
    });

    return connectPromise;
  }

  async function disconnect(): Promise<void> {
    if (!client) return;

    manualDisconnect = true;
    clearReconnectTimer();
    reconnectAttempts = 0;
    connectPromise = null;

    return new Promise((resolve) => {
      logger.info("Disconnecting from MQTT broker");
      client?.end(false, {}, () => {
        client?.removeAllListeners();
        client = null;
        messageHandlers.clear();
        logger.info("MQTT disconnected");
        resolve();
      });
    });
  }

  async function publish(
    topic: string,
    message: string,
    qos: 0 | 1 | 2 = config.qos,
    userProperties?: Record<string, string>
  ): Promise<void> {
    if (!client?.connected) {
      throw new Error("MQTT not connected");
    }

    // Prepare publish options with user properties if available
    const options: any = { qos };
    if (userProperties && Object.keys(userProperties).length > 0) {
      options.properties = {
        userProperties: {
          ...userProperties
        }
      };
    }
    const properties_str = JSON.stringify(options)
    logger.info(`properties to ${properties_str}`);
    return new Promise((resolve, reject) => {
      client!.publish(topic, message, options, (err) => {
        if (err) {
          logger.error(`Failed to publish to ${topic}: ${err.message}`);
          reject(err);
        } else {
          logger.debug(`Published to ${topic}: ${message.slice(0, 100)}...`);
          resolve();
        }
      });
    });
  }

  function subscribe(topic: string, handler: MessageHandler): void {
    const handlers = messageHandlers.get(topic) ?? [];
    handlers.push(handler);
    messageHandlers.set(topic, handlers);

    // If already connected, subscribe immediately
    if (client?.connected) {
      client.subscribe(topic, { qos: config.qos }, (err) => {
        if (err) {
          logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
        } else {
          logger.debug(`Subscribed to ${topic}`);
        }
      });
    }
  }

  function isConnected(): boolean {
    return client?.connected ?? false;
  }

  function getInitialUserProperties(): Record<string, string> | undefined {
    return initialUserProperties && Object.keys(initialUserProperties).length > 0 
      ? { ...initialUserProperties } 
      : undefined;
  }

  function getClientId(): string | undefined {
    return config.clientId;
  }

  return {
    connect,
    disconnect,
    publish,
    subscribe,
    isConnected,
    getInitialUserProperties,
    getClientId,
  };
}

/**
 * Check if a topic matches a subscription pattern.
 * Supports MQTT wildcards: + (single level) and # (multi level)
 */
function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === topic) return true;
  if (!pattern.includes("+") && !pattern.includes("#")) return false;

  const patternParts = pattern.split("/");
  const topicParts = topic.split("/");

  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];

    if (p === "#") {
      // # matches everything from here
      return true;
    }

    if (p === "+") {
      // + matches exactly one level
      if (i >= topicParts.length) return false;
      continue;
    }

    if (p !== topicParts[i]) {
      return false;
    }
  }

  return patternParts.length === topicParts.length;
}
