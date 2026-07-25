// Copy non-TypeScript assets (the bundled knowledge markdown) into dist/, since
// `tsc` only emits compiled code. Run as part of `npm run build`.
import { cp, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "knowledge");
const dest = join(root, "dist", "knowledge");

if (!existsSync(src)) {
  console.log("no knowledge/ directory yet — nothing to copy");
  process.exit(0);
}

await mkdir(dest, { recursive: true });
await cp(src, dest, { recursive: true, filter: (p) => !p.endsWith(".ts") });
console.log(`copied ${(await readdir(dest)).length} knowledge files to dist/knowledge`);
