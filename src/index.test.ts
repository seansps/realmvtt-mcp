import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const builtEntry = resolve(here, "..", "dist", "index.js");

/**
 * Start the built server the way a real install does and complete an MCP
 * handshake, returning the `initialize` response.
 */
function handshake(entry: string, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`No response within ${timeoutMs}ms. stderr: ${stderr || "(silent)"}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d;
      for (const line of stdout.split("\n").filter(Boolean)) {
        try {
          const msg = JSON.parse(line) as { id?: number; result?: Record<string, unknown> };
          if (msg.id === 1 && msg.result) {
            clearTimeout(timer);
            child.kill();
            resolvePromise(msg.result);
            return;
          }
        } catch {
          // Partial line; wait for the rest.
        }
      }
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `Server exited with code ${code} before responding. ` +
            `stdout: ${stdout || "(empty)"} stderr: ${stderr || "(silent)"}`,
        ),
      );
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        },
      })}\n`,
    );
  });
}

// These drive the compiled output, which only exists after a build. `npm test`
// builds first; a bare `vitest` run in a dirty tree shouldn't fail for that.
const built = existsSync(builtEntry);
describe.skipIf(!built)("the published binary", () => {
  it("starts when run directly", async () => {
    const result = await handshake(builtEntry);
    expect((result.serverInfo as { name: string }).name).toBe("realmvtt");
  });

  /**
   * REGRESSION: npm installs a bin as a SYMLINK, so `process.argv[1]` is the link
   * while `import.meta.url` is the resolved target. An entry guard comparing them
   * raw never fires — the server starts, registers nothing, and exits 0 silently.
   * That shipped in 0.1.0 and made every `npx realmvtt-mcp` install a no-op, while
   * `node dist/index.js` (no symlink) worked perfectly in testing.
   */
  it("starts when invoked through a symlink, the way npx and global installs do", async () => {
    const linkDir = mkdtempSync(join(tmpdir(), "realmvtt-bin-"));
    const link = join(linkDir, "realmvtt-mcp");
    symlinkSync(builtEntry, link);

    const result = await handshake(link);
    expect((result.serverInfo as { name: string }).name).toBe("realmvtt");
  });

  it("advertises its tools over the symlinked entry point", async () => {
    const linkDir = mkdtempSync(join(tmpdir(), "realmvtt-bin-"));
    const link = join(linkDir, "realmvtt-mcp");
    symlinkSync(builtEntry, link);

    const result = await handshake(link);
    expect(result.capabilities).toHaveProperty("tools");
  });

  /**
   * The version a client sees comes from SERVER_VERSION, not package.json, so the
   * two drift silently: 0.9.1 published while the handshake still said 0.9.0.
   * Nothing breaks loudly, which is exactly why it goes unnoticed.
   */
  it("advertises the version it was published as", async () => {
    const pkg = JSON.parse(
      await readFile(resolve(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    const result = await handshake(builtEntry);
    expect((result.serverInfo as { version: string }).version).toBe(pkg.version);
  });
});
