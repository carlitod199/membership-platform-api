"use strict";

/**
 * Parse every JavaScript file in the repository (excluding node_modules) and
 * report failures. `node --check` per file, without depending on a shell loop.
 *
 *   npm run check
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", ".git", "coverage", "tmp"]);

function collect(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, found);
    else if (entry.isFile() && entry.name.endsWith(".js")) found.push(full);
  }
  return found;
}

const files = collect(ROOT).sort();
const failures = [];

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failures.push({ file: path.relative(ROOT, file), message: String(error.stderr || error.message) });
  }
}

for (const failure of failures) {
  process.stderr.write(`FAIL ${failure.file}\n${failure.message}\n`);
}

process.stdout.write(
  `${files.length - failures.length}/${files.length} JavaScript files parsed cleanly\n`
);
process.exit(failures.length ? 1 : 0);
