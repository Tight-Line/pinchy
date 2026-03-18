// audit-exempt: test connection is a read-only diagnostic action, no state change
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { testConnection } from "@/lib/mcp-servers";

type Params = { params: Promise<{ serverId: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const { serverId } = await params;
  const result = await testConnection(serverId);

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: result.error === "Server not found" ? 404 : 200 }
    );
  }

  return NextResponse.json({
    success: true,
    toolCount: result.tools?.length ?? 0,
  });
}
