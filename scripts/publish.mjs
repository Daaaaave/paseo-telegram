import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const artifact = `.artifacts/${pkg.name}-${pkg.version}.tgz`;
const integrity = `sha512-${createHash("sha512")
  .update(await readFile(artifact))
  .digest("base64")}`;
let published;
try {
  published = JSON.parse(
    execFileSync(
      "npm",
      ["view", `${pkg.name}@${pkg.version}`, "dist.integrity", "--json"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
} catch (error) {
  let code;
  try {
    code = JSON.parse(error.stdout).error?.code;
  } catch {}
  if (code !== "E404") throw error;
}
if (published) {
  assert.equal(
    published,
    integrity,
    "This version is already published with a different artifact. Release a new version.",
  );
  console.log(
    `${pkg.name}@${pkg.version} is already published with the inspected artifact.`,
  );
} else {
  execFileSync("npm", ["publish", artifact, "--access", "public"], {
    stdio: "inherit",
  });
}
