#!/usr/bin/env node

import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const INCLUDE_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const SKIP_DIRS = new Set([".git", ".github", "node_modules"]);
const SKIP_FILES = new Set(["scripts/authorization-guard.mjs"]);

const FORBIDDEN = [
  { label: "owner shortcut", regex: /site\.userId\s*[!=]==\s*session\.user\.id/ },
  { label: "admin shortcut", regex: /\bisAdministrator\s*\(/ },
  { label: "raw role capability", regex: /\broleHasCapability\s*\(/ },
  { label: "raw site role", regex: /\bgetSiteUserRole\s*\(/ },
  { label: "rbac import", regex: /from\s+["'][^"']*rbac(?:\.ts)?["']/ },
  { label: "membership table reference", regex: /\b(site_users|site_user_meta|siteUsers|siteUserMeta|membership)\b/ },
];
const ALLOWED_CAN_USER_CALLS = new Set(["canUserAccessSiteCapability", "canUserManageNetworkCapability"]);

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...(await walk(full)));
      continue;
    }
    if (!INCLUDE_EXT.has(path.extname(entry.name))) continue;
    if (SKIP_FILES.has(rel)) continue;
    out.push(full);
  }
  return out;
}

async function main() {
  const files = await walk(ROOT);
  const offenders = [];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    const text = await fs.readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rule of FORBIDDEN) {
        if (rule.regex.test(line)) {
          offenders.push(`${rel}:${idx + 1} ${rule.label} -> ${line.trim()}`);
        }
      }
    });

    for (const match of text.matchAll(/\b(canUser[A-Za-z0-9_]+)\s*\(/g)) {
      const helper = match[1];
      if (!ALLOWED_CAN_USER_CALLS.has(helper)) {
        const offset = match.index ?? 0;
        const line = text.slice(0, offset).split(/\r?\n/).length;
        offenders.push(`${rel}:${line} disallowed auth helper -> ${helper}(...)`);
      }
    }
  }

  if (offenders.length > 0) {
    console.error("Authorization static guard failed:");
    for (const offender of offenders) {
      console.error(` - ${offender}`);
    }
    process.exit(1);
  }

  console.log("Authorization static guard passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
