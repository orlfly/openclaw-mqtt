import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resetMock, getMockClient } from "./__mocks__/mqtt.js";

// Mock the mqtt module
vi.mock("mqtt", () => import("./__mocks__/mqtt.js"));

// Import after mocking
import { mqttPlugin, createMqttSendTool } from "./channel.js";
import { setMqttRuntime } from "./runtime.js";

describe("mqttPlugin", () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockDispatchReply = vi.fn(async ({ dispatcherOptions }: any) => {
    if (dispatcherOptions?.deliver) {
      await dispatcherOptions.deliver({ text: "test reply" }, { kind: "final" });
    }
  });
  const mockFinalizeInboundContext = vi.fn((payload: any) => payload);

  const mockRuntime = {
    channel: {
      reply: {
        finalizeInboundContext: mockFinalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply,
      },
    },
  };

  const defaultCfg = {
    channels: {
      mqtt: {
        brokerUrl: "mqtt://localhost:1883",
        topics: {
          inbound: "openclaw/inbound",
          outbound: "openclaw/outbound",
        },
        qos: 1 as const,
      },
    },
  };

  const startAccount = async (cfg: any = defaultCfg, accountId = "default") => {
    const controller = new AbortController();
    const startPromise = mqttPlugin.gateway?.startAccount?.({
      cfg,
      accountId,
      log: mockLogger,
      abortSignal: controller.signal,
    } as any);

    // Wait for async connect
    await new Promise((r) => setTimeout(r, 50));

    return { controller, startPromise };
  };

  beforeEach(() => {
    resetMock();
    vi.clearAllMocks();
    setMqttRuntime(mockRuntime as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("meta", () => {
    it("should have correct id and label", () => {
      expect(mqttPlugin.id).toBe("mqtt");
      expect(mqttPlugin.meta.label).toBe("MQTT");
      expect(mqttPlugin.meta.aliases).toContain("mosquitto");
    });
  });

  describe("capabilities", () => {
    it("should support direct chat only", () => {
      expect(mqttPlugin.capabilities.chatTypes).toContain("direct");
      expect(mqttPlugin.capabilities.supportsMedia).toBe(true);
      expect(mqttPlugin.capabilities.supportsReactions).toBe(false);
    });
  });

  describe("config", () => {
    it("should list account IDs when configured", () => {
      const ids = mqttPlugin.config.listAccountIds(defaultCfg as any);
      expect(ids).toContain("default");
    });

    it("should return empty when not configured", () => {
      const ids = mqttPlugin.config.listAccountIds({} as any);
      expect(ids).toEqual([]);
    });

    it("should resolve account with broker URL", () => {
      const account = mqttPlugin.config.resolveAccount(defaultCfg as any, "default");
      expect(account.brokerUrl).toBe("mqtt://localhost:1883");
    });
  });

  describe("gateway.startAccount", () => {
    it("should skip if not configured", async () => {
      await mqttPlugin.gateway?.startAccount?.({
        cfg: {} as any,
        accountId: "default",
        log: mockLogger,
        abortSignal: new AbortController().signal,
      } as any);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        "MQTT channel not configured, skipping"
      );
    });

    it("should connect and subscribe when configured", async () => {
      const { controller, startPromise } = await startAccount();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("starting MQTT provider")
      );

      const mock = getMockClient();
      expect(mock?.subscriptions.has("openclaw/inbound")).toBe(true);

      controller.abort();
      await startPromise;
    });

    it("should process inbound MQTT messages", async () => {
      const { controller, startPromise } = await startAccount();

      const mock = getMockClient();
      mock?.simulateMessage("openclaw/inbound", "Alert: Service down");

      expect(mockDispatchReply).toHaveBeenCalled();
      const lastCall = mockDispatchReply.mock.calls.at(-1)?.[0];
      expect(lastCall?.ctx?.Body).toBe("Alert: Service down");

      controller.abort();
      await startPromise;
    });

    it("should parse JSON messages", async () => {
      const { controller, startPromise } = await startAccount();

      const mock = getMockClient();
      mock?.simulateMessage(
        "openclaw/inbound",
        JSON.stringify({
          id: "msg-001",
          text: "Server CPU high",
          senderId: "uptime-kuma",
          timestamp: new Date().toISOString(),
          type: "text",
        })
      );

      expect(mockDispatchReply).toHaveBeenCalled();
      const lastCall = mockDispatchReply.mock.calls.at(-1)?.[0];
      expect(lastCall?.ctx?.Body).toBe("Server CPU high");
      expect(lastCall?.ctx?.SenderId).toBe("uptime-kuma");

      controller.abort();
      await startPromise;
    });

    it("should echo senderId in outbound replies", async () => {
      const { controller, startPromise } = await startAccount();

      const mock = getMockClient();
      mock?.simulateMessage(
        "openclaw/inbound",
        JSON.stringify({
          id: "msg-002",
          text: "ping",
          senderId: "pg-test",
          timestamp: new Date().toISOString(),
          type: "text",
        })
      );

      const published = mock?.published ?? [];
      expect(published.length).toBeGreaterThan(0);
      const last = published[published.length - 1];
      const data = JSON.parse(last.message as string);
      expect(data.senderId).toBe("openclaw");
      expect(data.text).toBe("test reply");
      expect(data.id).toBeDefined();
      expect(data.timestamp).toBeDefined();

      controller.abort();
      await startPromise;
    });
  });

  describe("gateway.abort", () => {
    it("should disconnect cleanly", async () => {
      const { controller, startPromise } = await startAccount();

      controller.abort();
      await startPromise;

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("MQTT channel stopping")
      );
    });
  });

  describe("outbound.sendText", () => {
    it("should publish to outbound topic", async () => {
      const { controller, startPromise } = await startAccount();

      const result = await mqttPlugin.outbound.sendText({
        text: "Hello from OpenClaw",
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(true);

      const mock = getMockClient();
      const publishedMsg = mock?.published[0];
      expect(publishedMsg).toBeDefined();
      expect(publishedMsg).toEqual(
        expect.objectContaining({
          topic: "openclaw/outbound",
        })
      );

      // Verify message is JSON formatted with MqttMessage fields
      const parsedMessage = JSON.parse(publishedMsg!.message);
      expect(parsedMessage.senderId).toBe("openclaw");
      expect(parsedMessage.text).toBe("Hello from OpenClaw");
      expect(parsedMessage.id).toBeDefined();
      expect(parsedMessage.timestamp).toBeDefined();
      expect(parsedMessage.type).toBe("text");

      controller.abort();
      await startPromise;
    });

    it("should fail if not configured", async () => {
      const result = await mqttPlugin.outbound.sendText({
        text: "Hello",
        cfg: {} as any,
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("MQTT not configured");
    });

    it("should fail if not connected", async () => {
      const result = await mqttPlugin.outbound.sendText({
        text: "Hello",
        cfg: defaultCfg as any,
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("MQTT not connected");
    });
  });

  describe("outbound.sendMedia", () => {
    const smallBase64 = "SGVsbG8gV29ybGQ="; // "Hello World" - 11 bytes
    const smallDataUrl = `data:text/plain;base64,${smallBase64}`;

    it("should publish file message with data URL", async () => {
      const { controller, startPromise } = await startAccount();

      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: smallDataUrl,
        text: "hello.txt",
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(true);

      const mock = getMockClient();
      const publishedMsg = mock?.published[0];
      expect(publishedMsg).toBeDefined();
      expect(publishedMsg).toEqual(
        expect.objectContaining({
          topic: "openclaw/outbound",
        })
      );

      const parsedMessage = JSON.parse(publishedMsg!.message);
      expect(parsedMessage.senderId).toBe("openclaw");
      expect(parsedMessage.type).toBe("file");
      expect(parsedMessage.fileName).toBe("hello.txt");
      expect(parsedMessage.fileType).toBe("text/plain");
      expect(parsedMessage.fileData).toBe(smallBase64);
      expect(parsedMessage.id).toBeDefined();
      expect(parsedMessage.timestamp).toBeDefined();

      controller.abort();
      await startPromise;
    });

    it("should publish file message with raw base64 URL", async () => {
      const { controller, startPromise } = await startAccount();

      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: smallBase64,
        text: "hello.txt",
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(true);

      const mock = getMockClient();
      const parsedMessage = JSON.parse(mock!.published[0].message);
      expect(parsedMessage.type).toBe("file");
      expect(parsedMessage.fileData).toBe(smallBase64);
      expect(parsedMessage.fileName).toBe("hello.txt");

      controller.abort();
      await startPromise;
    });

    it("should extract fileName and mimeType from data URL", async () => {
      const { controller, startPromise } = await startAccount();

      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: "data:application/pdf;base64," + smallBase64,
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(true);

      const mock = getMockClient();
      const parsedMessage = JSON.parse(mock!.published[0].message);
      expect(parsedMessage.fileType).toBe("application/pdf");

      controller.abort();
      await startPromise;
    });

    it("should fail if not configured", async () => {
      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: smallDataUrl,
        cfg: {} as any,
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("MQTT not configured");
    });

    it("should fail if not connected", async () => {
      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: smallDataUrl,
        cfg: defaultCfg as any,
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("MQTT not connected");
    });

    it("should fail if media URL is missing", async () => {
      const { controller, startPromise } = await startAccount();

      const result = await mqttPlugin.outbound.sendMedia({
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toBe("Media URL or file path is required");

      controller.abort();
      await startPromise;
    });

    it("should reject files exceeding 10MB limit", async () => {
      const { controller, startPromise } = await startAccount();

      const oversizedBase64 = "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) * 4 / 3) + 1);
      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: `data:application/octet-stream;base64,${oversizedBase64}`,
        text: "big.bin",
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("File size exceeds limit");

      controller.abort();
      await startPromise;
    });

    it("should accept files at exactly 10MB", async () => {
      const { controller, startPromise } = await startAccount();

      const exactBytes = 10 * 1024 * 1024;
      const exactBase64 = "A".repeat(Math.ceil(exactBytes * 4 / 3));
      const result = await mqttPlugin.outbound.sendMedia({
        mediaUrl: exactBase64,
        text: "exact10mb.bin",
        cfg: defaultCfg as any,
        to: "openclaw/outbound",
      } as any);

      expect(result.ok).toBe(true);

      controller.abort();
      await startPromise;
    });
  });
});

describe("inbound message parsing", () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockDispatchReply = vi.fn(async ({ dispatcherOptions }: any) => {
    if (dispatcherOptions?.deliver) {
      await dispatcherOptions.deliver({ text: "test reply" }, { kind: "final" });
    }
  });
  const mockFinalizeInboundContext = vi.fn((payload: any) => payload);

  const mockRuntime = {
    channel: {
      reply: {
        finalizeInboundContext: mockFinalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply,
      },
    },
  };

  const cfg = {
    channels: {
      mqtt: {
        brokerUrl: "mqtt://localhost:1883",
        topics: { inbound: "test/in", outbound: "test/out" },
        qos: 1 as const,
      },
    },
  };

  const startAccount = async () => {
    const controller = new AbortController();
    const startPromise = mqttPlugin.gateway?.startAccount?.({
      cfg: cfg as any,
      accountId: "default",
      log: mockLogger,
      abortSignal: controller.signal,
    } as any);

    await new Promise((r) => setTimeout(r, 50));

    return { controller, startPromise };
  };

  beforeEach(() => {
    resetMock();
    vi.clearAllMocks();
    setMqttRuntime(mockRuntime as any);
  });

  it("should handle plain text messages", async () => {
    const { controller, startPromise } = await startAccount();

    getMockClient()?.simulateMessage("test/in", "Plain text alert");

    expect(mockDispatchReply).toHaveBeenCalled();
    const lastCall = mockDispatchReply.mock.calls.at(-1)?.[0];
    expect(lastCall?.ctx?.Body).toBe("Plain text alert");
    expect(lastCall?.ctx?.SenderId).toBe("test-in");

    controller.abort();
    await startPromise;
  });

  it("should extract message from various JSON formats", async () => {
    const { controller, startPromise } = await startAccount();

    const testCases = [
      { input: { id: "m1", text: "msg1", senderId: "s1", timestamp: new Date().toISOString() }, expected: "msg1" },
      { input: { id: "m2", text: "msg2", senderId: "s1", timestamp: new Date().toISOString() }, expected: "msg2" },
      { input: { id: "m3", text: "msg3", senderId: "s1", timestamp: new Date().toISOString() }, expected: "msg3" },
      { input: { id: "m4", text: "msg4", senderId: "s1", timestamp: new Date().toISOString() }, expected: "msg4" },
      { input: { id: "m5", text: "msg5", senderId: "s1", timestamp: new Date().toISOString() }, expected: "msg5" },
    ];

    for (const { input, expected } of testCases) {
      mockDispatchReply.mockClear();
      getMockClient()?.simulateMessage("test/in", JSON.stringify(input));

      const lastCall = mockDispatchReply.mock.calls.at(-1)?.[0];
      expect(lastCall?.ctx?.Body).toBe(expected);
    }

    controller.abort();
    await startPromise;
  });

  it("should extract sender from JSON", async () => {
    const { controller, startPromise } = await startAccount();

    const testCases = [
      { input: { id: "m1", text: "x", senderId: "src1", timestamp: new Date().toISOString() }, expectedSender: "src1" },
      { input: { id: "m2", text: "x", senderId: "src2", timestamp: new Date().toISOString() }, expectedSender: "src2" },
      { input: { id: "m3", text: "x", senderId: "src3", timestamp: new Date().toISOString() }, expectedSender: "src3" },
      { input: { id: "m4", text: "x", senderId: "src4", timestamp: new Date().toISOString() }, expectedSender: "src4" },
    ];

    for (const { input, expectedSender } of testCases) {
      mockDispatchReply.mockClear();
      getMockClient()?.simulateMessage("test/in", JSON.stringify(input));

      const lastCall = mockDispatchReply.mock.calls.at(-1)?.[0];
      expect(lastCall?.ctx?.SenderId).toBe(expectedSender);
    }

    controller.abort();
    await startPromise;
  });
});

describe("mqtt_send tool", () => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const mockDispatchReply = vi.fn(async ({ dispatcherOptions }: any) => {
    if (dispatcherOptions?.deliver) {
      await dispatcherOptions.deliver({ text: "test reply" }, { kind: "final" });
    }
  });
  const mockFinalizeInboundContext = vi.fn((payload: any) => payload);

  const mockRuntime = {
    channel: {
      reply: {
        finalizeInboundContext: mockFinalizeInboundContext,
        dispatchReplyWithBufferedBlockDispatcher: mockDispatchReply,
      },
    },
  };

  const cfg = {
    channels: {
      mqtt: {
        brokerUrl: "mqtt://localhost:1883",
        topics: { inbound: "test/in", outbound: "test/out" },
        qos: 1 as const,
        clientId: "openclaw-agent",
      },
    },
  };

  const startAccount = async () => {
    const controller = new AbortController();
    const startPromise = mqttPlugin.gateway?.startAccount?.({
      cfg: cfg as any,
      accountId: "default",
      log: mockLogger,
      abortSignal: controller.signal,
    } as any);

    await new Promise((r) => setTimeout(r, 50));

    return { controller, startPromise };
  };

  beforeEach(() => {
    resetMock();
    vi.clearAllMocks();
    setMqttRuntime(mockRuntime as any);
  });

  it("should publish to specified topic (group message)", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-1", {
      text: "Hello group",
      topic: "openclaw/group/room1",
      targetIds: ["clientA", "clientB"],
    });

    expect(result.ok).toBe(true);
    expect(result.topic).toBe("openclaw/group/room1");
    expect(result.targetIds).toEqual(["clientA", "clientB"]);

    const mock = getMockClient();
    const publishedMsg = mock?.published[0];
    expect(publishedMsg).toBeDefined();
    expect(publishedMsg!.topic).toBe("openclaw/group/room1");

    const parsed = JSON.parse(publishedMsg!.message);
    expect(parsed.senderId).toBe("openclaw-agent");
    expect(parsed.text).toBe("Hello group");
    expect(parsed.targetIds).toEqual(["clientA", "clientB"]);
    expect(parsed.type).toBe("text");

    controller.abort();
    await startPromise;
  });

  it("should publish to resolved targetClientId topic (private chat)", async () => {
    const { controller, startPromise } = await startAccount();

    // Simulate inbound message to register replyTopic for "user-device"
    const mock = getMockClient();
    mock?.simulateMessage("test/in", JSON.stringify({
      id: "msg-001",
      text: "hello",
      senderId: "user-device",
      timestamp: new Date().toISOString(),
    }), {
      properties: {
        userProperties: { reply_to: "user-device/replies" },
      },
    });

    const tool = createMqttSendTool();
    const result = await tool.execute("call-2", {
      text: "Hello private",
      targetClientId: "user-device",
    });

    expect(result.ok).toBe(true);
    expect(result.topic).toBe("user-device/replies");

    const publishedMsg = mock?.published.at(-1);
    expect(publishedMsg).toBeDefined();
    expect(publishedMsg!.topic).toBe("user-device/replies");

    const parsed = JSON.parse(publishedMsg!.message);
    expect(parsed.senderId).toBe("openclaw-agent");
    expect(parsed.text).toBe("Hello private");

    controller.abort();
    await startPromise;
  });

  it("should return error when targetClientId is not registered", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-3", {
      text: "Hello",
      targetClientId: "unknown-device",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("has not registered");

    controller.abort();
    await startPromise;
  });

  it("should return error when no topic source provided", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-4", { text: "Hello" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("One of topic, targetClientId, or conversationLabel");

    controller.abort();
    await startPromise;
  });

  it("should return error when multiple topic sources provided", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-5", {
      text: "Hello",
      topic: "some/topic",
      targetClientId: "some-device",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Provide only one of");

    controller.abort();
    await startPromise;
  });

  it("should resolve group topic from conversationLabel", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-6", {
      text: "Hello group",
      conversationLabel: "mqtt:group:openclaw/groups/room1",
    });

    expect(result.ok).toBe(true);
    expect(result.topic).toBe("openclaw/groups/room1");

    const mock = getMockClient();
    const publishedMsg = mock?.published[0];
    expect(publishedMsg!.topic).toBe("openclaw/groups/room1");

    controller.abort();
    await startPromise;
  });

  it("should resolve private chat topic from conversationLabel", async () => {
    const { controller, startPromise } = await startAccount();

    // Register reply topic for "device-a"
    const mock = getMockClient();
    mock?.simulateMessage("test/in", JSON.stringify({
      id: "msg-001",
      text: "hello",
      senderId: "device-a",
      timestamp: new Date().toISOString(),
    }), {
      properties: {
        userProperties: { reply_to: "device-a/replies" },
      },
    });

    const tool = createMqttSendTool();
    const result = await tool.execute("call-7", {
      text: "Hello private",
      conversationLabel: "mqtt:device-a",
    });

    expect(result.ok).toBe(true);
    expect(result.topic).toBe("device-a/replies");

    const publishedMsg = mock?.published.at(-1);
    expect(publishedMsg!.topic).toBe("device-a/replies");

    controller.abort();
    await startPromise;
  });

  it("should return error for unrecognized conversationLabel", async () => {
    const { controller, startPromise } = await startAccount();

    const tool = createMqttSendTool();
    const result = await tool.execute("call-8", {
      text: "Hello",
      conversationLabel: "invalid-format",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unrecognized conversationLabel format");

    controller.abort();
    await startPromise;
  });

  it("should return error when MQTT not connected", async () => {
    const tool = createMqttSendTool();
    const result = await tool.execute("call-9", {
      text: "Hello",
      topic: "some/topic",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("MQTT not connected");
  });
});
