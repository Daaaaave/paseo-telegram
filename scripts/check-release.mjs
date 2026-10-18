import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
assert.match(pkg.version, /^\d+\.\d+\.\d+$/, "Only stable releases are published as latest");
assert.equal(process.env.RELEASE_TAG, `v${pkg.version}`, "Tag must match package version");
assert.equal(pkg.repository.url, `git+https://github.com/${process.env.RELEASE_REPOSITORY}.git`, "Repository must match package identity");
console.log(`Release identity verified: ${pkg.name}@${pkg.version}`);
