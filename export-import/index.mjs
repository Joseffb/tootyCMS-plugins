import { inflateRawSync } from "node:zlib";

function asBool(value, fallback = false) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function parseJsonSafe(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

function parseStringList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean);
  }
  const parsed = parseJsonSafe(raw);
  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean);
  }
  return String(raw || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function parseConfigObject(raw) {
  const parsed = parseJsonSafe(raw);
  return parsed && typeof parsed === "object" ? parsed : {};
}

function asArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  return null;
}

function toUint8(value) {
  const direct = asArrayBuffer(value);
  if (direct) return new Uint8Array(direct);
  if (typeof value === "string") return new TextEncoder().encode(value);
  return new Uint8Array();
}

function encodeBase64(bytes) {
  if (!bytes || bytes.length === 0) return "";
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return new Uint8Array();
  return new Uint8Array(Buffer.from(normalized, "base64"));
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(chunks) {
  const total = chunks.reduce((sum, item) => sum + item.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function dosDateTime(dateInput = new Date()) {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const second = Math.floor(date.getUTCSeconds() / 2);
  const dosTime = (hour << 11) | (minute << 5) | second;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosDate, dosTime };
}

function buildZip(entriesInput) {
  const entries = (Array.isArray(entriesInput) ? entriesInput : [])
    .map((entry) => ({
      name: String(entry?.name || "").trim(),
      bytes: toUint8(entry?.bytes ?? entry?.content ?? ""),
      date: entry?.date instanceof Date ? entry.date : new Date(),
    }))
    .filter((entry) => entry.name.length > 0);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const dataBytes = entry.bytes;
    const checksum = crc32(dataBytes);
    const { dosDate, dosTime } = dosDateTime(entry.date);

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, dataBytes.length, true);
    localView.setUint32(22, dataBytes.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, dosTime, true);
    centralView.setUint16(14, dosDate, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, dataBytes.length, true);
    centralView.setUint32(24, dataBytes.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    localParts.push(localHeader, dataBytes);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBytes.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const localData = concatBytes(localParts);
  const endRecord = new Uint8Array(22);
  const endView = new DataView(endRecord.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralDirectory.length, true);
  endView.setUint32(16, localData.length, true);
  endView.setUint16(20, 0, true);

  return concatBytes([localData, centralDirectory, endRecord]);
}

function parseZipJsonPayload(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : toUint8(bytes);
  let offset = 0;
  while (offset + 30 <= u8.length) {
    const view = new DataView(u8.buffer, u8.byteOffset + offset, u8.length - offset);
    const signature = view.getUint32(0, true);
    if (signature !== 0x04034b50) break;
    const compression = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLength;
    const name = new TextDecoder().decode(u8.subarray(nameStart, nameEnd));
    const dataStart = nameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > u8.length) break;
    const compressed = u8.subarray(dataStart, dataEnd);
    let fileBytes = compressed;
    if (compression === 8) {
      fileBytes = new Uint8Array(inflateRawSync(Buffer.from(compressed)));
    } else if (compression !== 0) {
      offset = dataEnd;
      continue;
    }
    if (name.toLowerCase().endsWith(".json")) {
      return new TextDecoder().decode(fileBytes);
    }
    offset = dataEnd;
  }
  return null;
}

async function resolveImportPayloadBytes(params) {
  const payloadBase64 = String(params.payloadBase64 || "").trim();
  if (payloadBase64) return decodeBase64(payloadBase64);
  const payloadRaw = params.payload;
  if (typeof payloadRaw === "string" && payloadRaw.length > 0) {
    return new TextEncoder().encode(payloadRaw);
  }
  const payloadBuffer = asArrayBuffer(payloadRaw);
  if (payloadBuffer) return new Uint8Array(payloadBuffer);
  const payloadUrl = String(params.payloadUrl || "").trim();
  if (payloadUrl && /^https?:\/\//i.test(payloadUrl)) {
    const response = await fetch(payloadUrl, { method: "GET" });
    if (!response.ok) {
      throw new Error(`Failed to fetch import payload URL (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  return new Uint8Array();
}

function detectPayloadKind(bytes, params) {
  const mime = String(params.payloadMimeType || "").toLowerCase();
  const url = String(params.payloadUrl || "").toLowerCase();
  if (mime.includes("zip") || url.endsWith(".zip")) return "zip";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return "zip";
  }
  return "json";
}

function normalizeProvider(raw, source = "builtin") {
  const provider = asObject(raw);
  const id = String(provider.id || "").trim().toLowerCase();
  if (!id) return null;
  const label = String(provider.label || id).trim() || id;
  const version = String(provider.version || "0.1.0").trim() || "0.1.0";
  const capabilitiesRaw = asObject(provider.capabilities);
  const handlersRaw = asObject(provider.handlers);

  return {
    id,
    label,
    version,
    source,
    capabilities: {
      export: Boolean(capabilitiesRaw.export ?? false),
      import: Boolean(capabilitiesRaw.import ?? false),
      inspect: Boolean(capabilitiesRaw.inspect ?? true),
      apply: Boolean(capabilitiesRaw.apply ?? false),
    },
    handlers: {
      exportPayload:
        typeof handlersRaw.exportPayload === "function" ? handlersRaw.exportPayload : null,
      inspectImport:
        typeof handlersRaw.inspectImport === "function" ? handlersRaw.inspectImport : null,
      applyImport:
        typeof handlersRaw.applyImport === "function" ? handlersRaw.applyImport : null,
    },
  };
}

function dedupeProviders(list) {
  const byId = new Map();
  for (const item of list) {
    const normalized = normalizeProvider(item, item?.source || "plugin");
    if (!normalized) continue;
    byId.set(normalized.id, normalized);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function buildBuiltinProviders(api) {
  const snapshot = {
    id: "snapshot",
    label: "Snapshot",
    version: "0.1.0",
    source: "builtin",
    capabilities: {
      export: true,
      import: true,
      inspect: true,
      apply: false,
    },
    handlers: {
      exportPayload: async ({ siteId, options }) => {
        const [site, domains, taxonomies] = await Promise.all([
          api.core.site.get(siteId),
          api.core.dataDomain.list(siteId),
          api.core.taxonomy.list(),
        ]);
        const payload = {
          ok: true,
          format: "snapshot",
          generatedAt: new Date().toISOString(),
          siteId,
          options: asObject(options),
          payload: {
            manifest: {
              schemaVersion: "1",
              kind: "snapshot",
            },
            site,
            dataDomains: domains,
            taxonomies,
          },
        };
        const payloadJson = JSON.stringify(payload, null, 2);
        const zipBytes = buildZip([
          {
            name: "snapshot.json",
            bytes: new TextEncoder().encode(payloadJson),
          },
        ]);
        const fileTs = new Date().toISOString().replace(/[:.]/g, "-");
        return new Response(zipBytes, {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename=\"snapshot-${siteId || "network"}-${fileTs}.zip\"`,
          },
        });
      },
      inspectImport: async ({ payload, params }) => {
        const bytes = await resolveImportPayloadBytes({ ...asObject(params), payload });
        const kind = detectPayloadKind(bytes, params || {});
        const jsonText = kind === "zip"
          ? parseZipJsonPayload(bytes)
          : new TextDecoder().decode(bytes);
        if (!jsonText) {
          return {
            ok: true,
            format: "snapshot",
            summary: { payloadKind: kind, bytes: bytes.length, schemaVersion: "unknown" },
            warnings: [
              "Snapshot archive detected but no JSON manifest was found for deep inspect.",
            ],
          };
        }
        const parsed = parseJsonSafe(jsonText) || {};
        const manifest = asObject(parsed.manifest);
        const dataDomains = Array.isArray(parsed.dataDomains) ? parsed.dataDomains.length : 0;
        const taxonomies = Array.isArray(parsed.taxonomies) ? parsed.taxonomies.length : 0;
        return {
          ok: true,
          format: "snapshot",
          summary: {
            payloadKind: kind,
            bytes: bytes.length,
            schemaVersion: String(manifest.schemaVersion || "unknown"),
            dataDomains,
            taxonomies,
          },
          warnings: [
            "Snapshot apply is intentionally disabled in built-in provider pending transactional restore flow.",
          ],
        };
      },
      applyImport: async ({ payload, params }) => {
        const bytes = await resolveImportPayloadBytes({ ...asObject(params), payload });
        const payloadKind = detectPayloadKind(bytes, params || {});
        return {
        ok: false,
        blocked: true,
        payloadKind,
        reason: "Snapshot apply is not enabled in built-in provider yet.",
        };
      },
    },
  };

  const articlesJson = {
    id: "articles-json",
    label: "Articles JSON",
    version: "0.1.0",
    source: "builtin",
    capabilities: {
      export: true,
      import: true,
      inspect: true,
      apply: false,
    },
    handlers: {
      exportPayload: async ({ siteId, options }) => {
        const domains = await api.core.dataDomain.list(siteId);
        const includeDomains = Array.isArray(options?.domains)
          ? options.domains.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
          : ["post", "page"];

        return {
          ok: true,
          format: "articles-json",
          generatedAt: new Date().toISOString(),
          siteId,
          options: asObject(options),
          payload: {
            manifest: {
              schemaVersion: "1",
              kind: "articles-json",
            },
            includeDomains,
            availableDomains: domains,
            articles: [],
          },
          warnings: [
            "Built-in articles-json export currently emits envelope + domain metadata; article row export adapter is child-provider extensible.",
          ],
        };
      },
      inspectImport: async ({ payload }) => {
        const parsed = parseJsonSafe(payload) || {};
        const articles = Array.isArray(parsed.articles) ? parsed.articles.length : 0;
        const includeDomains = Array.isArray(parsed.includeDomains) ? parsed.includeDomains.length : 0;
        return {
          ok: true,
          format: "articles-json",
          summary: {
            includeDomains,
            articles,
          },
          warnings: [
            "Built-in articles-json apply is disabled until full write-plan + rollback contract is enabled.",
          ],
        };
      },
      applyImport: async () => ({
        ok: false,
        blocked: true,
        reason: "Articles JSON apply is not enabled in built-in provider yet.",
      }),
    },
  };

  return [snapshot, articlesJson];
}

async function resolveProviders(kernel, api) {
  const allowChildProviders = asBool(await api.getPluginSetting("allowChildProviders", "true"), true);
  let providers = buildBuiltinProviders(api);
  if (!allowChildProviders) return dedupeProviders(providers);

  try {
    providers = await kernel.applyFilters("export-import:providers", providers, {
      pluginId: "export-import",
      now: new Date().toISOString(),
    });
  } catch {
    // Keep builtin providers if extension filter chain fails.
  }

  const deduped = dedupeProviders(providers);
  const globalConfig = parseConfigObject(await api.core.settings.get("plugin_export-import_config", "{}"));
  const globalDisabled = new Set(parseStringList(globalConfig.disabledProviders || "[]"));
  const networkRequired = new Set(parseStringList(globalConfig.networkRequiredProviders || "[]"));
  const siteDisabled = new Set(parseStringList(await api.getPluginSetting("siteDisabledProviders", "[]")));
  return deduped.map((provider) => ({
    ...provider,
    enabled: !globalDisabled.has(provider.id) && (networkRequired.has(provider.id) || !siteDisabled.has(provider.id)),
    networkRequired: networkRequired.has(provider.id),
  }));
}

function summarizeProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    version: provider.version,
    source: provider.source,
    enabled: provider.enabled !== false,
    networkRequired: provider.networkRequired === true,
    capabilities: provider.capabilities,
  };
}

export async function register(kernel, api) {
  kernel.addAction("request:begin", async (context = {}) => {
    if (!context?.debug) return;
    const providers = await resolveProviders(kernel, api);
    context.trace = [
      ...(context.trace || []),
      `export-import:providers=${providers.map((provider) => provider.id).join(",")}`,
    ];
  }, 30);

  kernel.addFilter("domain:query", async (current, context = {}) => {
    const name = String(context?.name || "").trim();
    if (!name.startsWith("export_import.")) return current;

    const params = asObject(context?.params);
    const siteId = String(params.siteId || context?.siteId || "").trim();

    const providers = await resolveProviders(kernel, api);
    const byId = new Map(providers.map((provider) => [provider.id, provider]));

    if (name === "export_import.providers") {
      const defaultFormat = String(await api.getPluginSetting("defaultFormat", "snapshot") || "snapshot").trim();
      return Response.json({
        ok: true,
        defaultFormat,
        providers: providers.map(summarizeProvider),
      });
    }

    if (name === "export_import.export") {
      const format = String(params.format || await api.getPluginSetting("defaultFormat", "snapshot") || "snapshot")
        .trim()
        .toLowerCase();
      const provider = byId.get(format);
      if (!provider) return Response.json({ ok: false, error: `Unknown provider '${format}'.` }, { status: 404 });
      if (provider.enabled === false) {
        return Response.json({ ok: false, error: `Provider '${format}' is disabled.` }, { status: 403 });
      }
      if (!provider.capabilities.export || !provider.handlers.exportPayload) {
        return Response.json({ ok: false, error: `Provider '${format}' does not support export.` }, { status: 400 });
      }
      const result = await provider.handlers.exportPayload({
        siteId,
        options: asObject(params.options),
        params,
      });
      if (result instanceof Response) {
        return result;
      }
      return Response.json({ ...asObject(result), provider: summarizeProvider(provider) });
    }

    if (name === "export_import.import.inspect") {
      const format = String(params.format || "").trim().toLowerCase();
      const provider = byId.get(format);
      if (!provider) return Response.json({ ok: false, error: `Unknown provider '${format}'.` }, { status: 404 });
      if (provider.enabled === false) {
        return Response.json({ ok: false, error: `Provider '${format}' is disabled.` }, { status: 403 });
      }
      if (!provider.capabilities.inspect || !provider.handlers.inspectImport) {
        return Response.json({ ok: false, error: `Provider '${format}' does not support import inspect.` }, { status: 400 });
      }
      const result = await provider.handlers.inspectImport({
        siteId,
        payload: params.payload,
        params,
      });
      return Response.json({ ...asObject(result), provider: summarizeProvider(provider) });
    }

    if (name === "export_import.import.apply") {
      const allowApply = asBool(await api.getPluginSetting("allowImportApply", "false"), false);
      if (!allowApply) {
        return Response.json(
          {
            ok: false,
            blocked: true,
            reason: "Import apply is disabled by plugin setting.",
          },
          { status: 403 },
        );
      }

      const format = String(params.format || "").trim().toLowerCase();
      const provider = byId.get(format);
      if (!provider) return Response.json({ ok: false, error: `Unknown provider '${format}'.` }, { status: 404 });
      if (provider.enabled === false) {
        return Response.json({ ok: false, error: `Provider '${format}' is disabled.` }, { status: 403 });
      }
      if (!provider.capabilities.apply || !provider.handlers.applyImport) {
        return Response.json({ ok: false, error: `Provider '${format}' does not support import apply.` }, { status: 400 });
      }
      const result = await provider.handlers.applyImport({
        siteId,
        payload: params.payload,
        options: asObject(params.options),
        params,
      });
      return Response.json({ ...asObject(result), provider: summarizeProvider(provider) });
    }

    return current;
  }, 15);
}
