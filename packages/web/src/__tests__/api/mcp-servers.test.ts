import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────────

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/mcp-servers", () => ({
  listMcpServers: vi.fn(),
  getMcpServer: vi.fn(),
  createMcpServer: vi.fn(),
  updateMcpServer: vi.fn(),
  deleteMcpServer: vi.fn(),
  discoverTools: vi.fn(),
  testConnection: vi.fn(),
  validateCommand: vi.fn(),
  getMcpToolDefinitions: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  deleteMcpServer,
  discoverTools,
  testConnection,
  validateCommand,
  getMcpToolDefinitions,
} from "@/lib/mcp-servers";

const adminSession = {
  user: { id: "admin-1", role: "admin" },
  expires: "",
} as any;

const memberSession = {
  user: { id: "user-1", role: "member" },
  expires: "",
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(validateCommand).mockReturnValue(null);
});

// ── GET /api/mcp-servers ─────────────────────────────────────────────────

describe("GET /api/mcp-servers", () => {
  let GET: typeof import("@/app/api/mcp-servers/route").GET;

  beforeEach(async () => {
    const mod = await import("@/app/api/mcp-servers/route");
    GET = mod.GET;
  });

  it("returns servers for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(listMcpServers).mockResolvedValueOnce([
      {
        id: "srv-1",
        name: "GitHub",
        transport: "stdio",
        command: "npx",
        args: [],
        url: null,
        status: "connected",
        statusMessage: null,
        lastCheckedAt: null,
        toolManifest: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        envVarKeys: ["GITHUB_TOKEN"],
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("GitHub");
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(memberSession);
    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);
    const response = await GET();
    expect(response.status).toBe(401);
  });
});

// ── POST /api/mcp-servers ────────────────────────────────────────────────

describe("POST /api/mcp-servers", () => {
  let POST: typeof import("@/app/api/mcp-servers/route").POST;

  beforeEach(async () => {
    const mod = await import("@/app/api/mcp-servers/route");
    POST = mod.POST;
  });

  it("creates stdio server for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const fakeServer = {
      id: "srv-new",
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      url: null,
      status: "unknown",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(createMcpServer).mockResolvedValueOnce(fakeServer);
    vi.mocked(discoverTools).mockResolvedValueOnce({
      success: true,
      tools: [{ name: "create_issue", description: "Create issue", inputSchema: {} }],
    });
    vi.mocked(getMcpServer).mockResolvedValueOnce({
      ...fakeServer,
      envVarKeys: ["GITHUB_TOKEN"],
    });

    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "GitHub",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@mcp/server-github"],
        envVars: { GITHUB_TOKEN: "ghp_abc" },
      }),
    });

    const response = await POST(request);
    expect(response.status).toBe(201);

    expect(createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "GitHub", transport: "stdio" })
    );
    expect(discoverTools).toHaveBeenCalledWith("srv-new");
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "mcp_server.created",
        resource: "mcp_server:srv-new",
      })
    );
  });

  it("rejects missing name", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ transport: "stdio", command: "npx" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects invalid transport", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Test", transport: "websocket" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects missing command for stdio", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Test", transport: "stdio" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects missing URL for http", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Test", transport: "http" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects invalid URL protocol", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Test", transport: "http", url: "ftp://example.com" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  it("rejects shell metacharacters in command", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(validateCommand).mockReturnValueOnce(
      "Command contains prohibited shell metacharacters"
    );

    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Evil", transport: "stdio", command: "npx; rm -rf /" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("shell metacharacters");
  });

  it("rejects invalid env var keys", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({
        name: "Test",
        transport: "stdio",
        command: "npx",
        envVars: { "bad-key": "value" },
      }),
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Invalid env var key");
  });

  it("returns 403 for non-admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(memberSession);
    const request = new NextRequest("http://localhost:7777/api/mcp-servers", {
      method: "POST",
      body: JSON.stringify({ name: "Test", transport: "stdio", command: "npx" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);
  });
});

// ── DELETE /api/mcp-servers/[serverId] ────────────────────────────────────

describe("DELETE /api/mcp-servers/[serverId]", () => {
  let DELETE: typeof import("@/app/api/mcp-servers/[serverId]/route").DELETE;

  beforeEach(async () => {
    const mod = await import("@/app/api/mcp-servers/[serverId]/route");
    DELETE = mod.DELETE;
  });

  it("deletes server for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getMcpServer).mockResolvedValueOnce({
      id: "srv-1",
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: [],
      url: null,
      status: "connected",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: [{ name: "create_issue", description: "", inputSchema: {} }],
      createdAt: new Date(),
      updatedAt: new Date(),
      envVarKeys: [],
    });
    vi.mocked(deleteMcpServer).mockResolvedValueOnce({
      id: "srv-1",
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: [],
      url: null,
      status: "connected",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: [{ name: "create_issue", description: "", inputSchema: {} }],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const request = new NextRequest("http://localhost:7777/api/mcp-servers/srv-1", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ serverId: "srv-1" }),
    });

    expect(response.status).toBe(200);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "mcp_server.deleted",
        detail: { name: "GitHub", toolCount: 1 },
      })
    );
  });

  it("returns 404 for unknown server", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getMcpServer).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost:7777/api/mcp-servers/nonexistent", {
      method: "DELETE",
    });
    const response = await DELETE(request, {
      params: Promise.resolve({ serverId: "nonexistent" }),
    });
    expect(response.status).toBe(404);
  });
});

// ── POST /api/mcp-servers/[serverId]/test ─────────────────────────────────

describe("POST /api/mcp-servers/[serverId]/test", () => {
  let POST: typeof import("@/app/api/mcp-servers/[serverId]/test/route").POST;

  beforeEach(async () => {
    const mod = await import("@/app/api/mcp-servers/[serverId]/test/route");
    POST = mod.POST;
  });

  it("returns success when connection works", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(testConnection).mockResolvedValueOnce({
      success: true,
      tools: [{ name: "tool1", description: "", inputSchema: {} }],
    });

    const request = new NextRequest("http://localhost:7777/api/mcp-servers/srv-1/test", {
      method: "POST",
    });
    const response = await POST(request, {
      params: Promise.resolve({ serverId: "srv-1" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.success).toBe(true);
    expect(body.toolCount).toBe(1);
  });

  it("returns error when connection fails", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(testConnection).mockResolvedValueOnce({
      success: false,
      error: "Connection refused",
    });

    const request = new NextRequest("http://localhost:7777/api/mcp-servers/srv-1/test", {
      method: "POST",
    });
    const response = await POST(request, {
      params: Promise.resolve({ serverId: "srv-1" }),
    });

    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe("Connection refused");
  });
});

// ── GET /api/mcp-servers/tools ───────────────────────────────────────────

describe("GET /api/mcp-servers/tools", () => {
  let GET: typeof import("@/app/api/mcp-servers/tools/route").GET;

  beforeEach(async () => {
    const mod = await import("@/app/api/mcp-servers/tools/route");
    GET = mod.GET;
  });

  it("returns flat tool list for admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getMcpToolDefinitions).mockResolvedValueOnce([
      {
        id: "mcp:srv-1:create_issue",
        label: "create_issue",
        description: "Create issue",
        category: "mcp",
        serverName: "GitHub",
      },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe("mcp:srv-1:create_issue");
  });
});
