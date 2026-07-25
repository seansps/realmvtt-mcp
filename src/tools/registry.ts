/**
 * Shared plumbing for tool definitions: result formatting, error translation, and
 * a couple of argument shapes every campaign tool accepts.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiError, AuthRequiredError, explainApiError } from "../api/errors.js";

/** The MCP SDK's tool-result shape. The index signature is part of its contract
 *  (handlers may attach extra top-level fields), so it has to be declared here too. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export function text(value: string): ToolResult {
  return { content: [{ type: "text", text: value }] };
}

/**
 * JSON for the model, pretty enough to read and capped so one careless `find`
 * can't flood the context window. Tools that can legitimately return a lot write
 * to a file instead and hand back the path.
 */
export function json(value: unknown, limit = 24_000): ToolResult {
  const body = JSON.stringify(value, null, 2);
  if (body.length <= limit) return text(body);
  return text(
    `${body.slice(0, limit)}\n\n… truncated (${body.length} chars total). ` +
      `Narrow the query, or use a tool that writes the full result to a file.`,
  );
}

export function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Turn any thrown value into a tool error the model can act on. */
export function toToolError(err: unknown): ToolResult {
  if (err instanceof AuthRequiredError) return failure(err.message);
  if (err instanceof ApiError) return failure(explainApiError(err));
  return failure(err instanceof Error ? err.message : String(err));
}

/** Wrap a handler so no tool call ever escapes as an unhandled rejection. */
export function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (err) {
      return toToolError(err);
    }
  };
}

/** Every campaign-scoped tool takes this, so a call can target a campaign ad hoc. */
export const campaignArg = {
  campaign: z
    .string()
    .optional()
    .describe(
      "Campaign id or invite code. Defaults to the campaign selected with `realm_use_campaign`.",
    ),
};

/** Destructive tools take this so a delete is never one hallucinated argument away. */
export const confirmArg = {
  confirm: z
    .boolean()
    .optional()
    .describe("Must be true to actually perform this destructive operation."),
};

export function requireConfirm(confirm: boolean | undefined, what: string): void {
  if (!confirm) {
    throw new Error(
      `Refusing to ${what} without confirmation. Show the user what will be affected, ` +
        `then call again with confirm: true.`,
    );
  }
}

export type ToolRegistrar = (server: McpServer) => void;
