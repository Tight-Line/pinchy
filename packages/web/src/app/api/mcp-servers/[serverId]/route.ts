import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { appendAuditLog, type UpdateDetail } from "@/lib/audit";
import {
  getMcpServer,
  updateMcpServer,
  deleteMcpServer,
  discoverTools,
  validateCommand,
} from "@/lib/mcp-servers";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

type Params = { params: Promise<{ serverId: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;

  const { serverId } = await params;
  const server = await getMcpServer(serverId);

  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  return NextResponse.json(server);
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { serverId } = await params;
  const existing = await getMcpServer(serverId);

  if (!existing) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const body = await request.json();
  const { name, transport, command, args, url, envVars } = body;

  // ── Validation ──────────────────────────────────────────────────────
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "Name cannot be empty" }, { status: 400 });
    }
    if (name.trim().length > 100) {
      return NextResponse.json({ error: "Name must be 100 characters or fewer" }, { status: 400 });
    }
  }

  if (transport !== undefined && !["stdio", "http"].includes(transport)) {
    return NextResponse.json({ error: 'Transport must be "stdio" or "http"' }, { status: 400 });
  }

  if (command !== undefined && command !== null) {
    if (typeof command !== "string" || !command.trim()) {
      return NextResponse.json({ error: "Command cannot be empty" }, { status: 400 });
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

  if (url !== undefined && url !== null) {
    if (typeof url !== "string" || !url.trim()) {
      return NextResponse.json({ error: "URL cannot be empty" }, { status: 400 });
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

  // ── Update ──────────────────────────────────────────────────────────
  let updated;
  try {
    updated = await updateMcpServer(serverId, {
      name: name?.trim(),
      transport,
      command: command !== undefined ? (command?.trim() ?? null) : undefined,
      args,
      url: url !== undefined ? (url?.trim() ?? null) : undefined,
      envVars: envVars !== undefined ? (envVars ?? null) : undefined,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update server";
    if (message.includes("unique")) {
      return NextResponse.json(
        { error: "A server with this name already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!updated) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  // ── Audit (only on actual changes) ─────────────────────────────────
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (name !== undefined && name.trim() !== existing.name) {
    changes.name = { from: existing.name, to: name.trim() };
  }
  if (transport !== undefined && transport !== existing.transport) {
    changes.transport = { from: existing.transport, to: transport };
  }
  if (command !== undefined && command?.trim() !== existing.command) {
    changes.command = { from: existing.command, to: command?.trim() ?? null };
  }
  if (url !== undefined && url?.trim() !== existing.url) {
    changes.url = { from: existing.url, to: url?.trim() ?? null };
  }

  if (Object.keys(changes).length > 0) {
    const detail: UpdateDetail = {
      server: { id: serverId, name: updated.name },
      changes,
    };
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "mcp_server.updated",
      resource: `mcp_server:${serverId}`,
      detail,
    }).catch(() => {});
  }

  // ── Re-discover on connection config changes ───────────────────────
  const connectionChanged =
    transport !== undefined ||
    command !== undefined ||
    url !== undefined ||
    args !== undefined ||
    envVars !== undefined;

  if (connectionChanged) {
    discoverTools(serverId).catch(() => {});
  }

  regenerateOpenClawConfig().catch(() => {});

  const fresh = await getMcpServer(serverId);
  return NextResponse.json(fresh);
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const sessionOrError = await requireAdmin();
  if (sessionOrError instanceof NextResponse) return sessionOrError;
  const session = sessionOrError;

  const { serverId } = await params;

  // Read before deleting (for audit snapshot)
  const existing = await getMcpServer(serverId);
  if (!existing) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  const deleted = await deleteMcpServer(serverId);
  if (!deleted) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "mcp_server.deleted",
    resource: `mcp_server:${serverId}`,
    detail: {
      name: existing.name,
      toolCount: existing.toolManifest?.length ?? 0,
    },
  }).catch(() => {});

  regenerateOpenClawConfig().catch(() => {});

  return NextResponse.json({ success: true });
}
