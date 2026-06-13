/**
 * mqtt-adapter.mjs — role-train 与 emqx-mqtt-clients 之间的薄适配层
 *
 * 这个文件是 role-train skill **唯一**直接处理 MQTT 通讯的地方。
 * 它把 emqx-mqtt-clients 的 CLI 子进程接口包成两个简单的 async 函数：
 *
 *   - MqttClient          训练时反复发消息 + 收回复（带超时配置）
 *   - healthCheck(opts)   训练前一次性 ping 探测
 *
 * 设计动机（参见 SKILL.md "架构：规划 + 委派"）：
 *   - role-train **不直接处理 MQTT**——所有 send-wait 都通过 exec 调
 *     emqx-mqtt-clients 脚本完成。这样避免自定义 MQTT 传输层的协议 bug。
 *   - 把这部分代码集中在一个文件，role-train 内部职责更清晰：
 *       conversation-planner.mjs  → 状态机 + 规划
 *       feedback-analyzer.mjs     → 回复分类
 *       mqtt-adapter.mjs          → 通讯（这个文件）
 *       train-role.mjs            → CLI 入口
 *
 * 输出格式契约（emqx-mqtt-clients send-wait）：
 *   STDOUT 最后一行是 JSON 数组，元素是 **JSON 序列化的字符串**（不是对象）
 *   例：["{\"id\":\"...\",\"senderId\":\"openclaw-test\",\"text\":\"...\"}"]
 *   读 .text 字段之前必须先 JSON.parse 一次。这条逻辑由 extractReplyText 集中处理。
 */

import { execFileSync, spawn } from "child_process";
import { existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, "..");
const EMQX_CLIENTS_DIR = resolve(SKILL_DIR, "..", "emqx-mqtt-clients", "scripts");
const EMQX_SEND_WAIT_SCRIPT = join(EMQX_CLIENTS_DIR, "emqx_agent_communicate.mjs");

/**
 * 找到 emqx-mqtt-clients 的 send-wait 入口脚本
 * @param {string} overridePath - 可选：调用方直接传路径（用于测试）
 * @returns {string}
 */
export function resolveEmqxScript(overridePath) {
  const p = overridePath || EMQX_SEND_WAIT_SCRIPT;
  if (!existsSync(p)) {
    throw new Error(
      `emqx-mqtt-clients skill 未找到: ${p}\n` +
      `   role-train 依赖 emqx-mqtt-clients 进行 MQTT 通讯，请先安装。`
    );
  }
  return p;
}

/**
 * 从 send-wait 的输出解析回复文本。
 * 处理嵌套 JSON：元素是字符串、再 JSON.parse 拿 .text。
 * @param {*} payload
 * @returns {string}
 */
export function extractReplyText(payload) {
  if (!payload) return "";
  if (typeof payload !== "string") return String(payload);
  try {
    const obj = JSON.parse(payload);
    return obj.text || obj.message || obj.content || payload;
  } catch {
    return payload;
  }
}

/**
 * 一次性的 send-wait 调用
 * @private
 * @param {string} scriptPath
 * @param {string} agent
 * @param {string} message
 * @param {number} timeoutSec
 * @param {number} idleTimeoutSec
 * @param {number} processTimeoutMs - execFileSync 的进程超时
 * @returns {string} stdout
 */
function _execSendWait(scriptPath, agent, message, timeoutSec, idleTimeoutSec, processTimeoutMs) {
  return execFileSync("node", [
    scriptPath,
    "send-wait",
    "--agent", agent,
    "--msg", message,
    "--timeout", String(timeoutSec),
    "--idle-timeout", String(idleTimeoutSec),
  ], {
    encoding: "utf-8",
    timeout: processTimeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    // P0-1 修复 (2026-06-12): 透传 stderr 到教头终端
    //   之前用 ["ignore", "pipe", "pipe"] 把 send-wait 的诊断日志全吞了
    //   ("→ Sent to..."、"Reply topic..."、"← Reply #N..."、"Idle timeout...")，
    //   导致 role-train 出问题时只能盲猜是 Agent 死锁还是协议问题。
    //   改成 ["ignore", "pipe", "inherit"]：
    //   - stdin  ignore (子进程不需要输入)
    //   - stdout pipe (要解析 JSON，必须 pipe 进来)
    //   - stderr inherit (透传给父进程终端)
    //   注意顺序：Node.js stdio 三元组是 [stdin, stdout, stderr]，不是 [stdin, stderr, stdout]！
    //   副作用：教头训练时会看到 send-wait 的详细诊断日志（更易排错）
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/**
 * 解析 send-wait 的 STDOUT，提取最后一条 reply 的 text
 * @private
 */
function _parseReplies(stdout) {
  const lines = stdout.split("\n").map(l => l.trim()).filter(Boolean);
  const jsonLine = lines.find(l => l.startsWith("[") || l.startsWith("{"));
  if (!jsonLine) return null;
  const parsed = JSON.parse(jsonLine);
  const replies = Array.isArray(parsed) ? parsed : [parsed];
  if (replies.length === 0) return null;
  return extractReplyText(replies[replies.length - 1]);
}

/**
 * MqttClient — 训练时反复使用的发送器。
 * 把"目标 agent / 超时配置"绑在实例上，避免每轮重复传参。
 *
 * 用法：
 *   const client = new MqttClient({ agent: "openclaw-test", timeout: 60, idleTimeout: 10 });
 *   const { reply, ok, error } = await client.sendAndAwait("你的消息");
 *
 * 两种模式：
 *   - mode="send-wait"（默认）: 委派 emqx-mqtt-clients 的 send-wait 子进程。适合实现了 mqtt-chat 协议
 *                                  reply_to userProperty 的 agent。
 *   - mode="raw":               本地启 listen 子进程订阅 `{agent}/inbound`，同时 fire-and-forget 发消息，
 *                               收到来自该 agent 的 reply 后过 idleTimeout 关闭窗口。**不依赖** agent 实现协议。
 *                               适合开放性对话 agent（如新初始化的 BOOTSTRAP 状态 agent）。
 */
export class MqttClient {
  constructor({ agent, timeout = 60, idleTimeout = 10, scriptPath, mode } = {}) {
    if (!agent) throw new Error("MqttClient: 'agent' is required");
    this.agent = agent;
    this.timeout = timeout;
    this.idleTimeout = idleTimeout;
    this.scriptPath = resolveEmqxScript(scriptPath);
    this.mode = mode || process.env.ROLE_TRAIN_MODE || "send-wait";
  }

  /**
   * 发一条消息并等待 agent 回复
   * @param {string} message
   * @returns {Promise<{ reply: string, ok: boolean, error?: string }>}
   */
  async sendAndAwait(message) {
    if (this.mode === "raw") {
      return this._sendAndAwaitRaw(message);
    }
    return this._sendAndAwaitSendWait(message);
  }

  async _sendAndAwaitSendWait(message) {
    try {
      const stdout = _execSendWait(
        this.scriptPath,
        this.agent,
        message,
        this.timeout,
        this.idleTimeout,
        // 进程硬上限：timeout + 15s 缓冲
        (this.timeout + 15) * 1000,
      );
      const replyText = _parseReplies(stdout);
      if (replyText === null) {
        return { reply: "", ok: false, error: "no reply parsed from send-wait output" };
      }
      return { reply: String(replyText), ok: true };
    } catch (err) {
      const stderr = err.stderr?.toString() || err.message || "";
      if (stderr.includes("No reply received")) {
        return { reply: "", ok: false, error: "timeout: no reply received" };
      }
      if (stderr.includes("EMQX_HOST not set")) {
        return { reply: "", ok: false, error: "missing env: EMQX_HOST not set" };
      }
      return { reply: "", ok: false, error: stderr || err.message };
    }
  }

  /**
   * Raw 模式：发 fire-and-forget + 临时启 listen 收 {agent}/inbound，**不依赖** agent 实现 reply_to 协议。
   * 适合 BOOTSTRAP 状态 / 新初始化的普通对话 agent。
   * 流程：
   *   1. spawn listen 子进程（带 timeout 安全限）
   *   2. 等 200ms 让 listen 建立订阅
   *   3. spawn send fire-and-forget
   *   4. 等待：最先到的是 firstReply = firstTimeout；收到第一条后过 idleTimeout 关门
   *   5. 合并所有 reply，按发送顺序取 text
   * @private
   */
  async _sendAndAwaitRaw(message) {
    const senderId = process.env.EMQX_SENDER_ID || "trainer";  // 2026-06-12 改: 默认 'trainer' (跨平台友好)
    const senderName = process.env.EMQX_SENDER_NAME || "教头";
    const senderEmoji = process.env.EMQX_SENDER_EMOJI || "🛠️";
    const senderDesc = process.env.EMQX_SENDER_DESC || "Agent培训师";
    const listenTimeout = this.timeout + this.idleTimeout + 5;
    const listenScript = this.scriptPath;

    return new Promise((resolve) => {
      const self = this;
      const replies = [];
      let settled = false;
      let firstTimer = null;
      let idleTimer = null;
      let listenProc = null;
      let sendProc = null;

      function cleanup() {
        if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
        if (idleTimer)  { clearTimeout(idleTimer);  idleTimer  = null; }
        try { if (listenProc && !listenProc.killed) listenProc.kill("SIGTERM"); } catch {}
        try { if (sendProc && !sendProc.killed) sendProc.kill("SIGTERM"); } catch {}
      }

      function finish(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function resetIdleTimer() {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          // 静默超时，输出结果
          if (replies.length === 0) {
            finish({ reply: "", ok: false, error: `timeout: no reply received in raw mode (${this.timeout}s)` });
          } else {
            const merged = replies.map(r => r.text).join("\n");
            finish({ reply: merged, ok: true });
          }
        }, this.idleTimeout * 1000);
      }

      // 1. 启 listen 进程
      listenProc = spawn("node", [
        listenScript, "listen", "--timeout", String(listenTimeout),
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let listenBuf = "";
      listenProc.stdout.on("data", (chunk) => {
        listenBuf += chunk.toString("utf-8");
        // listen 输出的格式是：时间戳 + from + body 多行
        // 在收完一行后尝试解析
        const lines = listenBuf.split("\n");
        listenBuf = lines.pop(); // 未完成行留 buffer
        for (const line of lines) {
          if (!line.trim()) continue;
          // 跳 [时间戳] ← openclaw-test/inbound 这种头部
          // 找 Body:   {...} 后面那行
          const m = line.match(/^\s*Body:\s*(\{.*\})\s*$/);
          if (!m) continue;
          try {
            const obj = JSON.parse(m[1]);
            // 过滤：只收来自目标 agent 的消息
            if (obj.senderId !== this.agent) continue;
            const text = obj.text || obj.message || obj.content || "";
            if (!text) continue;
            replies.push({ text, timestamp: Date.now() });
            // 重启 idle 计时
            resetIdleTimer.call(this);
          } catch {}
        }
      });
      listenProc.stderr.on("data", () => {});  // ignore
      listenProc.on("error", (err) => {
        finish({ reply: "", ok: false, error: `listen spawn error: ${err.message}` });
      });

      // 2. firstReply 超时
      firstTimer = setTimeout(() => {
        if (replies.length === 0) {
          finish({ reply: "", ok: false, error: `timeout: no reply received in raw mode (${this.timeout}s)` });
        } else {
          // 有 reply 的话继续等 idleTimeout，不立即结束
          resetIdleTimer.call(this);
        }
      }, this.timeout * 1000);

      // 3. 等 300ms 让 listen 订阅建立后，再发消息
      setTimeout(() => {
        sendProc = spawn("node", [
          listenScript, "send",
          "--agent", this.agent,
          "--msg", message,
          "--sender-id", senderId,
          "--sender-name", senderName,
          "--sender-emoji", senderEmoji,
          "--sender-desc", senderDesc,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        sendProc.stderr.on("data", () => {});
        sendProc.on("error", (err) => {
          // 发送失败不代表等不到——让超时走完
        });
      }, 300);
    });
  }
}

/**
 * 健康探测：训练前 ping 一下 agent，确认在线 + 会回话。
 *
 * P0-2 修复 (2026-06-12): 默认 timeout 从 20s 提到 60s
 *   背景：emqx-mqtt-clients 的 send-wait 默认 timeout = 300s，对冷启动很宽松；
 *   role-train 的 healthCheck 默认 20s 太短——今天 15:46 那次训练就是 broker/Agent
 *   刚连上后 Agent 处理延迟 > 20s，导致 healthCheck 误报 "agent may be locked/offline"。
 *   30 秒后 broker 暖机完成手动 ping 1.x 秒就回了。冷启动友好性修复。
 *
 * @param {object} opts
 * @param {string} opts.agent - 目标 agent clientId
 * @param {string} [opts.pingMsg="ping"] - 探测消息
 * @param {number} [opts.timeout=60] - 单轮超时（秒）（P0-2 修复：20 → 60）
 * @param {number} [opts.idleTimeout=10] - 静默窗口（秒）（P0-2 修复：8 → 10）
 * @param {string} [opts.scriptPath] - 可选：emqx 脚本路径覆盖（测试用）
 * @returns {Promise<{ok: boolean, reply?: string, error?: string}>}
 */
export async function healthCheck({ agent, pingMsg = "ping", timeout = 60, idleTimeout = 10, scriptPath } = {}) {
  if (!agent) throw new Error("healthCheck: 'agent' is required");
  const resolved = resolveEmqxScript(scriptPath);
  try {
    const stdout = _execSendWait(
      resolved,
      agent,
      pingMsg,
      timeout,
      idleTimeout,
      (timeout + 10) * 1000,
    );
    const text = _parseReplies(stdout);
    if (text === null) return { ok: false, error: "no reply parsed from health check output" };
    if (!text) return { ok: false, error: "empty health check reply" };
    return { ok: true, reply: String(text) };
  } catch (err) {
    const stderr = err.stderr?.toString() || err.message || "";
    if (stderr.includes("No reply received")) {
      return { ok: false, error: `ping timed out after ${timeout}s — agent may be locked/offline` };
    }
    return { ok: false, error: stderr || err.message };
  }
}
