import { NextResponse } from "next/server";
import { authenticateMcpRequest } from "@/lib/mcp/auth";
import { MCP_TOOL_DEFINITIONS, executeMcpTool, confirmMcpDraft } from "@/lib/mcp/tools";

// Hand-rolled MCP "Streamable HTTP" transport (JSON-RPC 2.0 over a
// single POST endpoint, one request/response per call -- no SSE
// stream, no server-held session) rather than the official
// @modelcontextprotocol/sdk: that SDK's transport classes are built
// around Node's raw http.IncomingMessage/ServerResponse, not the Fetch
// API Request/Response this App Router route handler gets, and this
// server has no need for the SDK's session/streaming machinery -- every
// call here is a single self-contained request, authenticated by its
// own bearer token (see lib/mcp/auth.ts), not a stateful session.
// Implementing the small slice of the spec actually needed
// (initialize, tools/list, tools/call) avoids an adapter layer that
// would otherwise be pure risk for zero benefit.
export const runtime = "nodejs";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

function rpcResult(id: JsonRpcId | undefined, result: unknown) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

export async function POST(request: Request) {
  const auth = await authenticateMcpRequest(request);
  if ("error" in auth) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, -32700, "Parse error");
  }

  const { id, method, params } = body;
  // A JSON-RPC notification has no "id" -- per spec, the server MUST
  // NOT reply with a JSON-RPC response body for one (only an empty
  // HTTP acknowledgement).
  const isNotification = !("id" in body);

  if (method === "notifications/initialized" || method === "ping") {
    return new NextResponse(null, { status: 202 });
  }

  if (method === "initialize") {
    const result = {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "inma-erp", version: "0.1.0" },
    };
    return isNotification ? new NextResponse(null, { status: 202 }) : rpcResult(id, result);
  }

  if (method === "tools/list") {
    return rpcResult(id, { tools: MCP_TOOL_DEFINITIONS });
  }

  if (method === "tools/call") {
    const toolName = typeof params?.name === "string" ? params.name : undefined;
    const toolArgs = (params?.arguments as Record<string, unknown> | undefined) ?? {};

    if (!toolName) {
      return rpcError(id, -32602, "Invalid params: missing tool name");
    }

    const outcome =
      toolName === "confirm_draft"
        ? await confirmMcpDraft(String(toolArgs.draft_id ?? ""), { userId: auth.userId })
        : await executeMcpTool(toolName, toolArgs, { userId: auth.userId });

    return rpcResult(id, {
      content: [{ type: "text", text: JSON.stringify(outcome.result) }],
      isError: outcome.isError ?? false,
    });
  }

  if (isNotification) {
    return new NextResponse(null, { status: 202 });
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export async function GET() {
  return NextResponse.json(
    { error: "This MCP server only supports the stateless POST transport." },
    { status: 405 },
  );
}
