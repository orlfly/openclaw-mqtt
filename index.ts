import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";

import { mqttPlugin, createMqttSendTool } from "./src/channel.js";
import { setMqttRuntime } from "./src/runtime.js";

const plugin = {
  id: "mqtt",
  name: "MQTT",
  description: "MQTT channel plugin for IoT and home automation integration",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setMqttRuntime(api.runtime);
    api.registerChannel({ plugin: mqttPlugin });
    api.registerTool(createMqttSendTool());
  },
};

export default plugin;
