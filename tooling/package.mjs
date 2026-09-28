import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
if (manifest.name !== "ct-usage-ring" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Unexpected package identity");
}
const files = ["package.json", "README.md", "LICENSE"];
for (const name of (await fs.readdir(path.join(root, "src"))).sort()) files.push(`src/${name}`);
for (const name of files) {
  const stat = await fs.lstat(path.join(root, name));
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${name}`);
}
const output = path.join(root, "dist");
await fs.mkdir(output, { recursive: true });
const name = `${manifest.name}-${manifest.version}.zip`;
const archive = path.join(output, name);
await fs.rm(archive, { force: true });
execFileSync("zip", ["-X", "-q", archive, ...files], { cwd: root, stdio: "inherit" });
const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
await fs.writeFile(path.join(output, "SHA256SUMS"), `${digest}  ${name}\n`);
console.log(`Created ${name} (${files.length} files; no symlinks)`);
