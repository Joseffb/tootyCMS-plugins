#!/usr/bin/env node
import path from "node:path";
import { readdir, readFile, writeFile } from "node:fs/promises";

const root = process.cwd();
const outputFile = path.join(root, "plugins.json");
const ignoredDirs = new Set([".git", ".github", "scripts", "node_modules"]);

function toStringOrNull(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  return null;
}

async function loadPluginManifest(dirName) {
  const manifestPath = path.join(root, dirName, "plugin.json");
  let raw;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch {
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const id = toStringOrNull(parsed.id) || dirName;
  const name = toStringOrNull(parsed.name) || id;

  return {
    id,
    name,
    description: toStringOrNull(parsed.description),
    version: toStringOrNull(parsed.version),
    minCoreVersion: toStringOrNull(parsed.minCoreVersion),
    scope: toStringOrNull(parsed.scope),
    distribution: toStringOrNull(parsed.distribution),
    developer: toStringOrNull(parsed.developer),
    website: toStringOrNull(parsed.website),
    directory: dirName,
  };
}

async function buildCatalog() {
  const entries = await readdir(root, { withFileTypes: true });
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !ignoredDirs.has(name))
    .sort((a, b) => a.localeCompare(b));

  const plugins = [];
  for (const dirName of dirs) {
    const manifest = await loadPluginManifest(dirName);
    if (manifest) plugins.push(manifest);
  }

  plugins.sort((a, b) => a.id.localeCompare(b.id));
  return plugins;
}

async function main() {
  const plugins = await buildCatalog();
  const payload = {
    plugins,
  };
  await writeFile(outputFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`[generate-plugins-catalog] wrote ${plugins.length} plugins to plugins.json`);
}

main().catch((error) => {
  console.error("[generate-plugins-catalog] failed", error);
  process.exit(1);
});

