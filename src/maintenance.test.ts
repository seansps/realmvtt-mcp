import { beforeEach, describe, expect, it } from "vitest";
import { MAINTENANCE_NOTICE, MCP2_URL, resetNoticeForTests } from "./maintenance.js";
import { safe, text } from "./tools/registry.js";

beforeEach(() => resetNoticeForTests());

describe("maintenance notice", () => {
  it("points to the hosted 2.0 server in plain American English, no em dashes", () => {
    expect(MCP2_URL).toBe("https://mcp.realmvtt.com");
    expect(MAINTENANCE_NOTICE).toContain(MCP2_URL);
    expect(MAINTENANCE_NOTICE).toContain("only receives critical fixes");
    expect(MAINTENANCE_NOTICE).not.toContain("—");
  });

  it("is appended to the first tool result only, after the tool's own output", async () => {
    const tool = safe(async () => text("result"));
    const first = await tool({});
    expect(first.content).toEqual([
      { type: "text", text: "result" },
      { type: "text", text: `Note: ${MAINTENANCE_NOTICE}` },
    ]);
    const second = await tool({});
    expect(second.content).toEqual([{ type: "text", text: "result" }]);
  });

  it("also rides on an error result, which stays an error", async () => {
    const failing = safe(async () => {
      throw new Error("boom");
    });
    const r = await failing({});
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("boom");
    expect(r.content[1]!.text).toContain("maintenance mode");
  });
});
