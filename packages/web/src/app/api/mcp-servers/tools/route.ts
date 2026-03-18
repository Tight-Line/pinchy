import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { getMcpToolDefinitions } from "@/lib/mcp-servers";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const tools = await getMcpToolDefinitions();
  return NextResponse.json(tools);
}
