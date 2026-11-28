#!/usr/bin/env node
// Fails if any package version the web app resolves changes without an intentional
// snapshot update, so adding apps/mobile (or anything else) can't move the web app's
// dependencies. Peer-resolution suffixes are ignored; versions are compared.
//
// Usage: node scripts/check-web-deps.mjs          check against apps/web/resolved-versions.json
//        node scripts/check-web-deps.mjs --write  refresh the snapshot after a deliberate web change
import { readFileSync, writeFileSync } from "node:fs";

const lock = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
const snapshotUrl = new URL("../apps/web/resolved-versions.json", import.meta.url);

const start = lock.indexOf("\n  apps/web:\n");
if (start < 0) throw new Error("apps/web is not in pnpm-lock.yaml");
const rest = lock.slice(start + 1);
const next = rest.slice(3).search(/\n {2}\S[^\n]*:\n/);
const block = next < 0 ? rest : rest.slice(0, next + 3);

const versions = {};
let current = null;
for (const line of block.split("\n")) {
  const name = line.match(/^ {6}('?)(.+?)\1:$/);
  if (name) current = name[2];
  const ver = line.match(/^ {8}version: (.+)$/);
  if (ver && current) versions[current] = ver[1].replace(/\(.*$/, "");
}

if (process.argv.includes("--write")) {
  writeFileSync(snapshotUrl, JSON.stringify(versions, null, 2) + "\n");
  console.log(`wrote ${Object.keys(versions).length} web dependency versions`);
  process.exit(0);
}
const expected = JSON.parse(readFileSync(snapshotUrl, "utf8"));
const changed = [...new Set([...Object.keys(expected), ...Object.keys(versions)])].filter(
  (k) => expected[k] !== versions[k],
);
if (changed.length) {
  for (const k of changed) console.error(`web dependency changed: ${k} ${expected[k] ?? "(none)"} -> ${versions[k] ?? "(removed)"}`);
  console.error("If this was deliberate, run: node scripts/check-web-deps.mjs --write");
  process.exit(1);
}
console.log(`web dependencies unchanged (${Object.keys(versions).length} checked)`);
