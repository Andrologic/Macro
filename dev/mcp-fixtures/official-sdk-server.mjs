// Official MCP SDK fixture (Lot A of docs/mcp-dual-era-implementation-plan.md).
// Minimal legacy-era stdio server built on @modelcontextprotocol/sdk, used to
// prove that a real SDK server communicates with Macro's Rust stdio harness.
// Stdio transport: JSON-RPC over NDJSON stdout; diagnostics go to stderr only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "macro-official-sdk-fixture",
  version: "0.1.0",
});

server.registerTool(
  "sdk-echo",
  {
    description: "Echoes the provided value back prefixed with 'echo:'.",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: `echo:${value}` }],
  }),
);

server.registerTool(
  "sdk-reverse",
  {
    description: "Reverses the provided value.",
    inputSchema: { value: z.string() },
  },
  async ({ value }) => ({
    content: [{ type: "text", text: [...value].reverse().join("") }],
  }),
);

await server.connect(new StdioServerTransport());
