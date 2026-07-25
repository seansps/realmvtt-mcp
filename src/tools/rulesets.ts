/**
 * Ruleset tools.
 *
 * Rulesets are big — a mature one runs to megabytes of HTML tab layouts and
 * JavaScript roll handlers — so `realm_get_ruleset` writes to a FILE and returns a
 * structural summary. Dumping one into the conversation would bury everything else.
 *
 * Reads return unminified source (the API only minifies when explicitly asked with
 * `?minify=true`), so a fetch → edit → write round trip preserves the original code.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Json } from "../api/client.js";
import { authStore } from "../auth/store.js";
import { session, withAuthRecovery } from "../context.js";
import { json, safe, text } from "./registry.js";

interface Ruleset extends Json {
  _id: string;
  name?: string;
  description?: string;
  version?: number;
  published?: boolean;
  ownerId?: string;
  records?: Array<{ name?: string; type?: string; tabs?: Array<{ name?: string }> }>;
  settings?: Json;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "ruleset"
  );
}

/** A map of the ruleset's shape — enough to reason about it without reading megabytes. */
export function describeRuleset(rs: Ruleset): Json {
  const records = Array.isArray(rs.records) ? rs.records : [];
  const scripts = (rs.settings as { otherSettings?: { scripts?: Json } } | undefined)?.otherSettings
    ?.scripts;
  return {
    id: rs._id,
    name: rs.name,
    version: rs.version,
    published: rs.published,
    description: rs.description,
    recordTypes: records.map((r) => ({
      type: r.type,
      name: r.name,
      tabs: (r.tabs ?? []).map((t) => t.name).filter(Boolean),
    })),
    globalScripts: scripts ? Object.keys(scripts) : [],
    settingsKeys: rs.settings ? Object.keys(rs.settings) : [],
  };
}

/** A directory is a ruleset-compiler checkout if it has the CLI entry point. */
export function isCompilerDir(dir: string): boolean {
  return existsSync(join(dir, "src", "cli.js")) && existsSync(join(dir, "package.json"));
}

/**
 * Find the user's ruleset-compiler checkout.
 *
 * Everyone lays their machine out differently, so this never guesses at a personal
 * directory structure. In priority order: what the caller passed, what the user
 * configured before, the environment variable, and finally a bounded search UPWARD
 * from the ruleset source directory — which finds a sibling checkout in a monorepo
 * without caring what the parent folders are called.
 */
export function findCompiler(opts: {
  explicit?: string;
  configured?: string;
  env?: string;
  near?: string;
} = {}): string | null {
  for (const candidate of [opts.explicit, opts.configured, opts.env]) {
    if (candidate && isCompilerDir(resolve(candidate))) return resolve(candidate);
  }

  // Walk up from the ruleset directory looking for a checkout beside it. Covers
  // `<repo>/tools/ruleset-compiler` next to `<repo>/my-ruleset`, and any similar
  // arrangement, without hardcoding anyone's folder names.
  const start = opts.near ? resolve(opts.near) : process.cwd();
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    for (const rel of ["ruleset-compiler", join("tools", "ruleset-compiler")]) {
      const candidate = join(dir, rel);
      if (isCompilerDir(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Monotonic suffix so two compiles in the same process can't collide on a temp path. */
let compileSeq = 0;
const counter = (): number => (compileSeq += 1);

function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolvePromise({ code: 1, stdout, stderr: String(err) }));
  });
}

export function registerRulesetTools(server: McpServer): void {
  server.registerTool(
    "realm_list_rulesets",
    {
      title: "List rulesets",
      description:
        "List rulesets available to the user: the ones they own, plus every published (public) " +
        "ruleset. Use `realm_get_ruleset` to download one for reference.",
      inputSchema: {
        scope: z
          .enum(["mine", "published", "all"])
          .optional()
          .describe("Which rulesets to list. Default `all`."),
        search: z.string().optional().describe("Filter by name (case-insensitive substring)."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      const scope = args.scope ?? "all";
      const me = authStore.read()?.user?._id;

      return withAuthRecovery(async () => {
        const rows = new Map<string, Json>();

        if (scope === "mine" || scope === "all") {
          // owned-rulesets is a custom find with its own (non-paginated) response.
          const owned = await client.find<Ruleset>("/owned-rulesets", { short: "true" });
          for (const r of owned.data) {
            rows.set(String(r._id), {
              id: r._id,
              ruleset: r.name,
              version: r.version,
              published: r.published,
              source: !me || String(r.ownerId ?? me) === String(me) ? "yours" : "shared",
            });
          }
        }

        if (scope === "published" || scope === "all") {
          const list = await client.find<Ruleset>("/ruleset-list", {});
          for (const r of list.data) {
            const id = String(r._id);
            if (rows.has(id)) continue;
            rows.set(id, {
              id: r._id,
              ruleset: r.name,
              description: r.description,
              published: true,
              source: "published",
            });
          }
        }

        let out = [...rows.values()];
        if (args.search) {
          const needle = args.search.toLowerCase();
          out = out.filter((r) => String(r.ruleset ?? "").toLowerCase().includes(needle));
        }
        return json({ count: out.length, rulesets: out });
      });
    }),
  );

  server.registerTool(
    "realm_get_ruleset",
    {
      title: "Download a ruleset to a file",
      description:
        "Fetch a ruleset and WRITE IT TO A FILE, returning the path plus a structural summary " +
        "(record types, tab names, global scripts). Rulesets are megabytes, so they are never " +
        "returned inline — read the file to study specific parts.",
      inputSchema: {
        id: z.string().describe("Ruleset id."),
        path: z
          .string()
          .optional()
          .describe("Where to write the JSON. Defaults to ./realm-rulesets/<name>.json"),
      },
    },
    safe(async (args) => {
      const client = session.client();
      return withAuthRecovery(async () => {
        const rs = await client.get<Ruleset>("/rulesets", args.id);
        const target = args.path
          ? isAbsolute(args.path)
            ? args.path
            : resolve(process.cwd(), args.path)
          : resolve(process.cwd(), "realm-rulesets", `${slugify(rs.name ?? args.id)}.json`);

        await mkdir(dirname(target), { recursive: true });
        const body = JSON.stringify(rs, null, 2);
        await writeFile(target, body, "utf8");

        return json({
          savedTo: target,
          bytes: body.length,
          summary: describeRuleset(rs),
        });
      });
    }),
  );

  server.registerTool(
    "realm_write_ruleset",
    {
      title: "Create or update a ruleset",
      description:
        "Upload a ruleset from a JSON file. With `id` it PATCHes that ruleset (the server allows " +
        "this only for the owner, and rejects batch patches); without one it creates a new " +
        "ruleset owned by the signed-in user. For rulesets maintained as source files, prefer " +
        "`realm_compile_ruleset`.",
      inputSchema: {
        path: z.string().describe("Path to the ruleset JSON file to upload."),
        id: z.string().optional().describe("Ruleset id to update. Omit to create a new one."),
      },
    },
    safe(async (args) => {
      const client = session.client();
      const file = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path);
      const payload = JSON.parse(await readFile(file, "utf8")) as Ruleset;

      return withAuthRecovery(async () => {
        const saved = args.id
          ? await client.patch<Ruleset>("/rulesets", args.id, payload)
          : await client.create<Ruleset>("/rulesets", payload);
        return json({ [args.id ? "updated" : "created"]: describeRuleset(saved) });
      });
    }),
  );

  server.registerTool(
    "realm_compile_ruleset",
    {
      title: "Compile and upload a ruleset directory",
      description:
        "Compile a ruleset SOURCE DIRECTORY (one containing ruleset.config.json, HTML tabs and JS " +
        "roll handlers) with the local ruleset-compiler and upload the result. Always previews " +
        "with --dry-run first unless `apply` is true. Requires a ruleset-compiler checkout; set " +
        "REALMVTT_RULESET_COMPILER if it isn't in the usual place.",
      inputSchema: {
        directory: z.string().describe("Path to the ruleset source directory."),
        id: z.string().optional().describe("Ruleset id to update. Omit with `create` to make a new one."),
        create: z.boolean().optional().describe("Create a new ruleset instead of updating."),
        apply: z
          .boolean()
          .optional()
          .describe("Actually upload. Without this it only compiles and reports what would change."),
        compilerPath: z
          .string()
          .optional()
          .describe(
            "Path to the ruleset-compiler checkout. Only needed once — it is remembered, " +
              "and is also found automatically when it sits near the ruleset directory.",
          ),
      },
    },
    safe(async (args) => {
      const dir = isAbsolute(args.directory) ? args.directory : resolve(process.cwd(), args.directory);
      if (!existsSync(join(dir, "ruleset.config.json"))) {
        return text(`${dir} has no ruleset.config.json — that isn't a ruleset source directory.`);
      }

      const compiler = findCompiler({
        explicit: args.compilerPath,
        configured: session.state().rulesetCompilerPath,
        env: process.env.REALMVTT_RULESET_COMPILER,
        near: dir,
      });

      if (!compiler) {
        return text(
          "Couldn't find a ruleset-compiler checkout.\n\n" +
            "Ask the user where theirs is and pass it as `compilerPath` (it will be remembered), " +
            "or have them set REALMVTT_RULESET_COMPILER.\n\n" +
            "If they don't have one, `realm_get_ruleset` and `realm_write_ruleset` can edit the " +
            "ruleset JSON directly instead — the compiler is only needed for rulesets kept as " +
            "source directories of HTML tabs and JS roll handlers.",
        );
      }

      // Remember it so the user is only ever asked once.
      if (session.state().rulesetCompilerPath !== compiler) {
        session.setState({ ...session.state(), rulesetCompilerPath: compiler });
      }

      // Compile to a FILE rather than letting the compiler upload.
      //
      // The compiler only accepts a credential as `--token <jwt>` on its command
      // line, which would expose the JWT in the process list to every other user on
      // the machine. Its `--output` mode needs no credential at all, so we compile
      // locally and then upload through our own authenticated client — same result,
      // and the token never leaves this process.
      const out = join(tmpdir(), `realmvtt-ruleset-${process.pid}-${counter()}.json`);
      const argv = [join(compiler, "src", "cli.js"), dir, "--output", out];
      const { code, stderr } = await run(process.execPath, argv, compiler);

      if (code !== 0 || !existsSync(out)) {
        return text(`Compilation failed (exit ${code}).\n\n${stderr.slice(-4000)}`);
      }

      try {
        const payload = JSON.parse(await readFile(out, "utf8")) as Ruleset;
        const summary = describeRuleset({ ...payload, _id: args.id ?? "(new)" });

        if (!args.apply) {
          return json({
            compiler,
            applied: false,
            compiled: summary,
            log: stderr.slice(-2000),
            next: args.id
              ? `Re-run with apply: true to upload this to ruleset ${args.id}.`
              : "Re-run with apply: true and either an `id` to update or `create: true`.",
          });
        }

        if (!args.id && !args.create) {
          return text(
            "Pass `id` to update an existing ruleset, or `create: true` to make a new one.",
          );
        }

        const client = session.client();
        return await withAuthRecovery(async () => {
          const saved = args.id
            ? await client.patch<Ruleset>("/rulesets", args.id, payload)
            : await client.create<Ruleset>("/rulesets", payload);
          return json({
            compiler,
            applied: true,
            [args.id ? "updated" : "created"]: describeRuleset(saved),
          });
        });
      } finally {
        await rm(out, { force: true });
      }
    }),
  );
}
