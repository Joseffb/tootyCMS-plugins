const DETECT_CACHE_MS = 30000;
let detectCache = { at: 0, key: "", result: null };

function asBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function cleanHeader(value) {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim();
}

function splitArgs(raw, fallback) {
  const text = String(raw || "").trim();
  if (!text) return [...fallback];
  return text.split(/\s+/).filter(Boolean);
}

async function getNodeTools() {
  if (process.env.NEXT_RUNTIME === "edge") return null;
  const [fs, cp] = await Promise.all([
    import("node:fs/promises"),
    import("node:child_process"),
  ]);
  return {
    access: fs.access,
    constants: fs.constants,
    runProcess: cp["spawn"],
  };
}

async function isExecutable(tools, filePath) {
  const value = String(filePath || "").trim();
  if (!tools || !value) return false;
  try {
    await tools.access(value, tools.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstExecutable(tools, candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    if (await isExecutable(tools, candidate)) return candidate;
  }
  return "";
}

async function detectTransports(input = {}) {
  const tools = await getNodeTools();
  if (!tools) {
    return {
      selected: null,
      detected: [],
      warning: "Sendmail detection unavailable in Edge runtime.",
    };
  }

  const transportSetting = String(input.transport || "auto").trim().toLowerCase() || "auto";
  const overridePath = String(input.overridePath || "").trim();
  const customCommandPath = String(input.customCommandPath || "").trim();
  const cacheKey = JSON.stringify({ transportSetting, overridePath, customCommandPath });
  if (detectCache.result && detectCache.key === cacheKey && Date.now() - detectCache.at < DETECT_CACHE_MS) {
    return detectCache.result;
  }

  const commonSendmailPaths = [overridePath, "/usr/sbin/sendmail", "/usr/lib/sendmail", "/opt/homebrew/sbin/sendmail"];

  let detected = [];

  const customExists = await isExecutable(tools, customCommandPath);
  if (customExists) {
    detected.push({ id: "custom", label: "Custom", command: customCommandPath, args: ["-t", "-i"] });
  }

  const sendmailPath = await firstExecutable(tools, commonSendmailPaths);

  const postfixDetected = Boolean(await firstExecutable(tools, ["/usr/sbin/postconf", "/opt/homebrew/sbin/postconf"]));
  const eximDetected = Boolean(await firstExecutable(tools, ["/usr/sbin/exim", "/usr/bin/exim", "/opt/homebrew/bin/exim"]));
  const opensmtpdDetected = Boolean(
    await firstExecutable(tools, [
      "/usr/sbin/smtpd",
      "/usr/sbin/smtpdctl",
      "/opt/homebrew/sbin/smtpd",
      "/opt/homebrew/sbin/smtpdctl",
    ]),
  );

  if (sendmailPath && postfixDetected) {
    detected.push({ id: "postfix", label: "Postfix", command: sendmailPath, args: ["-t", "-i"] });
  }
  if (sendmailPath && eximDetected) {
    detected.push({ id: "exim", label: "Exim", command: sendmailPath, args: ["-t", "-i"] });
  }
  if (sendmailPath && opensmtpdDetected) {
    detected.push({ id: "opensmtpd", label: "OpenSMTPD", command: sendmailPath, args: ["-t", "-i"] });
  }

  const msmtpPath = await firstExecutable(tools, ["/usr/bin/msmtp", "/opt/homebrew/bin/msmtp", "/usr/local/bin/msmtp"]);
  if (msmtpPath) {
    detected.push({ id: "msmtp", label: "msmtp", command: msmtpPath, args: ["-t"] });
  }

  const nullmailerPath = await firstExecutable(tools, [
    "/usr/sbin/nullmailer-inject",
    "/usr/bin/nullmailer-inject",
    "/opt/homebrew/bin/nullmailer-inject",
  ]);
  if (nullmailerPath) {
    detected.push({ id: "nullmailer", label: "nullmailer", command: nullmailerPath, args: ["-t", "-i"] });
  }

  const ssmtpPath = await firstExecutable(tools, ["/usr/sbin/ssmtp", "/usr/bin/ssmtp", "/opt/homebrew/bin/ssmtp"]);
  if (ssmtpPath) {
    detected.push({ id: "ssmtp", label: "ssmtp", command: ssmtpPath, args: ["-t"] });
  }

  if (sendmailPath) {
    detected.push({ id: "sendmail", label: "sendmail", command: sendmailPath, args: ["-t", "-i"] });
  }

  const byId = new Map();
  for (const entry of detected) {
    if (!byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const priority = ["custom", "postfix", "exim", "opensmtpd", "msmtp", "nullmailer", "ssmtp", "sendmail"];
  detected = Array.from(byId.values()).sort((a, b) => priority.indexOf(a.id) - priority.indexOf(b.id));

  let selected = null;
  if (transportSetting !== "auto") {
    selected = detected.find((entry) => entry.id === transportSetting) || null;
  }
  if (!selected) {
    selected = detected[0] || null;
  }

  const result = {
    selected,
    detected,
    warning: detected.length === 0 ? "No compatible sendmail daemon was detected." : "",
  };
  detectCache = { at: Date.now(), key: cacheKey, result };
  return result;
}

function buildMessagePayload(message, fromAddress) {
  const from = cleanHeader(fromAddress || process.env.MAIL_FROM || "no-reply@localhost");
  const to = cleanHeader(message?.to || "");
  const subject = cleanHeader(message?.subject || "(no subject)");
  const date = new Date().toUTCString();
  const id = cleanHeader(message?.id || `${Date.now()}`);
  const body = String(message?.body || "");

  return (
    `From: ${from}\n` +
    `To: ${to}\n` +
    `Subject: ${subject}\n` +
    `Date: ${date}\n` +
    `Message-ID: <tooty-${id}@localhost>\n` +
    `MIME-Version: 1.0\n` +
    `Content-Type: text/plain; charset=UTF-8\n\n` +
    `${body}\n`
  );
}

async function deliverWithCommand(tools, command, args, payload, timeoutMs) {
  return await new Promise((resolve) => {
    let settled = false;
    const proc = tools.runProcess(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve({ ok: false, error: `Sendmail command timed out after ${timeoutMs}ms.` });
    }, timeoutMs);

    proc.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    proc.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, response: { command, args } });
        return;
      }
      resolve({ ok: false, error: stderr.trim() || `Sendmail exited with code ${code}.` });
    });

    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

export async function register(kernel, api) {
  api.registerCommunicationProvider({
    id: "sendmail",
    channels: ["email"],
    deliver: async (message) => {
      const tools = await getNodeTools();
      if (!tools) {
        return { ok: false, error: "Sendmail provider is unavailable in Edge runtime." };
      }

      const transport = String(await api.getPluginSetting("transport", "auto") || "auto").trim().toLowerCase();
      const overridePath = String(await api.getPluginSetting("overridePath", "") || "").trim();
      const customCommandPath = String(await api.getPluginSetting("customCommandPath", "") || "").trim();
      const commandArgsRaw = String(await api.getPluginSetting("commandArgs", "") || "").trim();
      const timeoutMs = asInt(await api.getPluginSetting("timeoutMs", "10000"), 10000);
      const fromAddress = String(await api.getPluginSetting("fromAddress", "") || "").trim();

      const detected = await detectTransports({ transport, overridePath, customCommandPath });
      if (!detected.selected) {
        return { ok: false, error: detected.warning || "No sendmail-compatible transport detected." };
      }

      const selected = detected.selected;
      const args = splitArgs(commandArgsRaw, selected.args || ["-t", "-i"]);
      const payload = buildMessagePayload(message, fromAddress);
      const result = await deliverWithCommand(tools, selected.command, args, payload, timeoutMs);
      if (!result.ok) return result;
      return {
        ok: true,
        externalId: `sendmail:${selected.id}:${Date.now()}`,
        response: {
          selected: selected.id,
          command: selected.command,
          args,
        },
      };
    },
  });

  kernel.addFilter("admin:floating-widgets", async (widgets = [], context = {}) => {
    const showBannerRaw = await api.getPluginSetting("showDetectionBanner", null);
    const showBanner = showBannerRaw == null ? true : asBool(showBannerRaw, false);
    if (!showBanner) return widgets;

    const page = context?.page || {};
    const isPluginPage = Boolean(page?.isPluginPage);
    const pluginId = String(page?.pluginId || "").trim().toLowerCase();
    if (!isPluginPage || pluginId !== "communication-sendmail") return widgets;

    const transport = String(await api.getPluginSetting("transport", "auto") || "auto").trim().toLowerCase();
    const overridePath = String(await api.getPluginSetting("overridePath", "") || "").trim();
    const customCommandPath = String(await api.getPluginSetting("customCommandPath", "") || "").trim();
    const detected = await detectTransports({ transport, overridePath, customCommandPath });

    if (!detected.selected) {
      return [
        ...widgets,
        {
          id: "sendmail-detect-warning",
          title: "Sendmail Detection Warning",
          content:
            "No compatible sendmail daemon was detected. Set Override Sendmail Path or Custom Command Path in plugin settings.",
          position: "top-right",
          dismissSetting: {
            pluginId: "communication-sendmail",
            key: "showDetectionBanner",
            value: false,
          },
        },
      ];
    }

    const available = detected.detected.map((entry) => entry.id).join(", ");
    const modeLabel = transport === "auto" ? "auto" : transport;
    const content =
      detected.detected.length > 1
        ? `Detected multiple transports (${available}). Active: ${detected.selected.id} (${modeLabel} mode).`
        : `Detected transport: ${detected.selected.id}.`;

    return [
      ...widgets,
      {
        id: "sendmail-detect-info",
        title: "Sendmail Detection",
        content,
        position: "top-right",
        dismissSetting: {
          pluginId: "communication-sendmail",
          key: "showDetectionBanner",
          value: false,
        },
      },
    ];
  });
}
