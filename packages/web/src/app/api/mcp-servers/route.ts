import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";
import { listMcpServers, createMcpServer, discoverTools, validateCommand } from "@/lib/mcp-servers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

export async function GET() {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const servers = await listMcpServers();
  return NextResponse.json(servers);
}

export async function POST(request: NextRequest) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const body = await request.json();
  const { name, transport, command, args, url, envVars } = body;

  // ── Validation ──────────────────────────────────────────────────────
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (name.trim().length > 100) {
    return NextResponse.json({ error: "Name must be 100 characters or fewer" }, { status: 400 });
  }

  if (!transport || !["stdio", "http"].includes(transport)) {
    return NextResponse.json({ error: 'Transport must be "stdio" or "http"' }, { status: 400 });
  }

  if (transport === "stdio") {
    if (!command || typeof command !== "string" || !command.trim()) {
      return NextResponse.json(
        { error: "Command is required for stdio transport" },
        { status: 400 }
      );
    }
    if (command.trim().length > 200) {
      return NextResponse.json(
        { error: "Command must be 200 characters or fewer" },
        { status: 400 }
      );
    }
    const cmdError = validateCommand(command.trim());
    if (cmdError) {
      return NextResponse.json({ error: cmdError }, { status: 400 });
    }
  }

  if (transport === "http") {
    if (!url || typeof url !== "string" || !url.trim()) {
      return NextResponse.json({ error: "URL is required for HTTP transport" }, { status: 400 });
    }
    try {
      const parsed = new URL(url.trim());
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("bad protocol");
      }
    } catch {
      return NextResponse.json({ error: "URL must be a valid http/https URL" }, { status: 400 });
    }
  }

  if (args !== undefined) {
    if (!Array.isArray(args) || args.length > 20) {
      return NextResponse.json(
        { error: "Args must be an array of at most 20 items" },
        { status: 400 }
      );
    }
    if (!args.every((a: unknown) => typeof a === "string")) {
      return NextResponse.json({ error: "Args must be strings" }, { status: 400 });
    }
  }

  if (envVars !== undefined && envVars !== null) {
    if (typeof envVars !== "object" || Array.isArray(envVars)) {
      return NextResponse.json(
        { error: "envVars must be an object of key-value pairs" },
        { status: 400 }
      );
    }
    const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
    for (const key of Object.keys(envVars)) {
      if (!envKeyPattern.test(key)) {
        return NextResponse.json(
          { error: `Invalid env var key: "${key}". Keys must be alphanumeric + underscore.` },
          { status: 400 }
        );
      }
    }
  }

  // ── Create ──────────────────────────────────────────────────────────
  let server;
  try {
    server = await createMcpServer({
      name: name.trim(),
      transport,
      command: command?.trim(),
      args: args ?? [],
      url: url?.trim(),
      envVars: envVars ?? undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create server";
    if (message.includes("unique")) {
      return NextResponse.json(
        { error: "A server with this name already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  // ── Discover tools (best-effort) ───────────────────────────────────
  const discovery = await discoverTools(server.id);

  // ── Audit ──────────────────────────────────────────────────────────
  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "mcp_server.created",
    resource: `mcp_server:${server.id}`,
    detail: {
      server: { id: server.id, name: server.name },
      transport,
      command: command?.trim() ?? null,
      toolCount: discovery.tools?.length ?? 0,
    },
  }).catch(() => {});

  // ── Regenerate config ──────────────────────────────────────────────
  regenerateOpenClawConfig().catch(() => {});

  // Return the server with fresh tool data
  const { getMcpServer } = await import("@/lib/mcp-servers");
  const fresh = await getMcpServer(server.id);
  return NextResponse.json(fresh, { status: 201 });
}
