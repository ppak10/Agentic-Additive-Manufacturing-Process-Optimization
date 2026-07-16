// Shared helpers for shaping MCP tool results.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { InovaApiError } from "./client.js";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(err: unknown): CallToolResult {
  const text =
    err instanceof InovaApiError
      ? // Surface firmware validation messages (400 bodies) verbatim — they
        // name the offending knob and its allowed range.
        err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return { content: [{ type: "text", text }], isError: true };
}
