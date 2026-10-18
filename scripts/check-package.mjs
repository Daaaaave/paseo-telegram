import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const manifest = JSON.parse(await readFile(resolve(root, "paseo-plugin.json"), "utf8"));
const lock = JSON.parse(await readFile(resolve(root, "npm-shrinkwrap.json"), "utf8"));
assert.equal(pkg.name, "paseo-telegram");
assert.equal(pkg.private, undefined);
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.equal(manifest.id, "telegram");
assert.equal(manifest.requirements.paseo, ">=0.11.2 <0.12.0");
assert.equal(manifest.build, undefined, "npm already installs the production dependency tree");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const [artifact] = JSON.parse(execFileSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {cwd: root, encoding: "utf8"}));
const files = new Set(artifact.files.map(file => file.path));
const required = ["paseo-plugin.json", "package.json", "npm-shrinkwrap.json", "README.md", "OVERVIEW.md", "LICENSE", "index.client.tsx", "index.server.ts"];
for (const file of required) assert.ok(files.has(file), `Missing published file: ${file}`);
for (const file of files) {
 assert.ok(required.includes(file) || /^(?:client|server|shared|assets)\//.test(file), `Unexpected published file: ${file}`);
 const path = resolve(root, file);
 assert.ok(!relative(root, await realpath(path)).startsWith(".."), `File escapes package: ${file}`);
 if (/\.(?:tsx?|json|md)$/.test(file)) {
  const text = await readFile(path, "utf8");
  assert.ok(!/(?:BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})/.test(text), `Credential-like text in ${file}`);
  assert.ok(!/(?:\/home\/[^/\s]+\/\.paseo\/worktrees|\/var\/tmp\/|\.ssh\/)/i.test(text), `Private host or project reference in ${file}`);
 }
 if (/\.tsx?$/.test(file)) {
  const text = await readFile(path, "utf8");
  for (const match of text.matchAll(/(?:from\s*|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
   const target = resolve(dirname(path), match[1]);
   assert.ok(files.has(relative(root, target).replaceAll("\\", "/")), `Unpublished local import in ${file}: ${match[1]}`);
  }
 }
}
assert.ok(!/paseo plugin add|npm (?:install|i)(?:\s|`)/.test(await readFile(resolve(root,"OVERVIEW.md"),"utf8")), "Listing must omit install commands");
for (const entry of Object.values(lock.packages)) {
 if (entry.dev || !entry.resolved) continue;
 assert.ok(entry.version && entry.integrity && entry.resolved.startsWith("https://registry.npmjs.org/"), "Runtime dependency must have a public, pinned integrity-checked source");
}
console.log(`Checked ${pkg.name}@${pkg.version}: ${files.size} public files, ${artifact.unpackedSize} unpacked bytes`);
