// Copy the reference docs that already live in realm15-client into src/knowledge/,
// so the published package carries them and the effects guidance can never drift
// from the implementation it documents.
//
// The other files in src/knowledge/ are authored here and are NOT touched.
//
// Usage:
//   node scripts/sync-docs.mjs           copy
//   node scripts/sync-docs.mjs --check   exit non-zero if a copy is stale
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const clientRoot = process.env.REALM_CLIENT_DIR || join(root, "..", "realm15-client");
const from = join(clientRoot, "docs");
const to = join(root, "src", "knowledge");

/** client docs/<source> → knowledge/<dest> */
const DOCS = [
  ["effects-system.md", "effects.md"],
  ["effects-quick-reference.md", "effects-quick.md"],
  ["3d-asset-conventions.md", "3d-assets.md"],
];

const HEADER = (source) =>
  `<!-- Copied from realm15-client/docs/${source} by scripts/sync-docs.mjs.\n` +
  `     Edit it there, not here. \`npm run check:sync\` fails when this copy is stale. -->\n\n`;

const check = process.argv.includes("--check");

if (!existsSync(from)) {
  const message = `client docs not found at ${from} (set REALM_CLIENT_DIR)`;
  if (check) {
    // Nothing to compare against — a consumer's checkout won't have the client.
    console.log(`skip: ${message}`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

const stale = [];
for (const [source, dest] of DOCS) {
  const src = join(from, source);
  if (!existsSync(src)) {
    console.error(`missing in client: docs/${source}`);
    process.exitCode = 1;
    continue;
  }

  const contents = HEADER(source) + (await readFile(src, "utf8"));
  const target = join(to, dest);

  if (check) {
    const current = existsSync(target) ? await readFile(target, "utf8") : null;
    if (current !== contents) stale.push(dest);
    continue;
  }

  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

if (check) {
  if (stale.length) {
    console.error(
      `knowledge docs are stale:\n  ${stale.join("\n  ")}\nRun \`npm run sync:docs\`.`,
    );
    process.exit(1);
  }
  console.log(`docs in sync (${DOCS.length} files)`);
} else {
  console.log(`synced ${DOCS.length} docs from ${from}`);
}
