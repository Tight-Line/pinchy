// audit-exempt: discover only refreshes cached tool manifest, no state change worth auditing
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { discoverTools, getMcpServer } from "@/lib/mcp-servers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

type Params = { params: Promise<{ serverId: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const { serverId } = await params;
  const result = await discoverTools(serverId);

  if (!result.success) {
    if (result.error === "Server not found") {
      return NextResponse.json({ error: "Server not found" }, { status: 404 });
    }
    return NextResponse.json({
      success: false,
      error: result.error,
    });
  }

  regenerateOpenClawConfig().catch(() => {});

  const server = await getMcpServer(serverId);
  return NextResponse.json({
    success: true,
    server,
  });
}
