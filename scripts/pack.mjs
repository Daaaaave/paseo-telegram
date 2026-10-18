import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const gitPreparation = [["npm", "ci", "--omit=dev", "--ignore-scripts"]];

/** Git needs dependency preparation; npm acquisition already installs them. */
export async function withNpmPackage(inspect) {
  const manifest = JSON.parse(
    await readFile(join(root, "paseo-plugin.json"), "utf8"),
  );
  assert.deepEqual(
    manifest.build,
    gitPreparation,
    "Git installs must prepare the locked production dependencies",
  );
  const [listing] = JSON.parse(
    execFileSync(npm, ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  const stage = await mkdtemp(join(tmpdir(), "paseo-telegram-npm-"));
  try {
    for (const { path } of listing.files) {
      const source = await realpath(resolve(root, path));
      const local = relative(root, source);
      assert.ok(
        local && !isAbsolute(local) && !local.startsWith(".."),
        `Package path escapes source: ${path}`,
      );
      const target = resolve(stage, path);
      const staged = relative(stage, target);
      assert.ok(
        staged && !isAbsolute(staged) && !staged.startsWith(".."),
        `Package path escapes staging: ${path}`,
      );
      await mkdir(dirname(target), { recursive: true });
      await copyFile(source, target);
    }
    delete manifest.build;
    await writeFile(
      join(stage, "paseo-plugin.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    return await inspect(stage);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function packNpmPackage(destination = ".artifacts") {
  const output = resolve(destination);
  await mkdir(output, { recursive: true });
  return withNpmPackage((cwd) => {
    const [artifact] = JSON.parse(
      execFileSync(
        npm,
        ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
        { cwd, encoding: "utf8" },
      ),
    );
    return artifact;
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const artifact = await packNpmPackage(process.argv[2]);
  console.log(
    JSON.stringify({
      filename: artifact.filename,
      integrity: artifact.integrity,
      files: artifact.files.length,
      unpackedSize: artifact.unpackedSize,
    }),
  );
}
