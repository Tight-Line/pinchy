import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────

const {
  mockReturning,
  mockValues,
  mockInsert,
  mockSelectWhere,
  mockSelectFrom,
  mockSelect,
  mockUpdateReturning,
  mockUpdateWhere,
  mockUpdateSet,
  mockUpdate,
  mockDeleteReturning,
  mockDeleteWhere,
  mockDelete,
} = vi.hoisted(() => {
  const mockReturning = vi.fn();
  const mockValues = vi.fn().mockReturnValue({ returning: mockReturning });
  const mockInsert = vi.fn().mockReturnValue({ values: mockValues });

  const mockSelectWhere = vi.fn();
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  const mockUpdateReturning = vi.fn();
  const mockUpdateWhere = vi.fn().mockReturnValue({ returning: mockUpdateReturning });
  const mockUpdateSet = vi.fn().mockReturnValue({ where: mockUpdateWhere });
  const mockUpdate = vi.fn().mockReturnValue({ set: mockUpdateSet });

  const mockDeleteReturning = vi.fn();
  const mockDeleteWhere = vi.fn().mockReturnValue({ returning: mockDeleteReturning });
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return {
    mockReturning,
    mockValues,
    mockInsert,
    mockSelectWhere,
    mockSelectFrom,
    mockSelect,
    mockUpdateReturning,
    mockUpdateWhere,
    mockUpdateSet,
    mockUpdate,
    mockDeleteReturning,
    mockDeleteWhere,
    mockDelete,
  };
});

vi.mock("@/lib/encryption", () => ({
  encrypt: vi.fn((v: string) => `encrypted:${v}`),
  decrypt: vi.fn((v: string) => v.replace("encrypted:", "")),
  getOrCreateSecret: vi.fn(() => Buffer.alloc(32)),
}));

vi.mock("@/db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    delete: mockDelete,
  },
}));

vi.mock("@/db/schema", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/schema")>();
  return { ...actual };
});

import {
  getServerSlug,
  validateCommand,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  listMcpServers,
  getMcpToolDefinitions,
  buildMcporterServerConfig,
  decryptEnvVars,
} from "@/lib/mcp-servers";
import { encrypt, decrypt } from "@/lib/encryption";

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default chain returns after clearAllMocks
  mockValues.mockReturnValue({ returning: mockReturning });
  mockInsert.mockReturnValue({ values: mockValues });
  mockSelectFrom.mockReturnValue({ where: mockSelectWhere });
  mockSelect.mockReturnValue({ from: mockSelectFrom });
  mockUpdateSet.mockReturnValue({ where: mockUpdateWhere });
  mockUpdateWhere.mockReturnValue({ returning: mockUpdateReturning });
  mockUpdate.mockReturnValue({ set: mockUpdateSet });
  mockDeleteWhere.mockReturnValue({ returning: mockDeleteReturning });
  mockDelete.mockReturnValue({ where: mockDeleteWhere });
});

// ── getServerSlug ────────────────────────────────────────────────────────

describe("getServerSlug", () => {
  it("converts name to lowercase slug", () => {
    expect(getServerSlug("GitHub MCP")).toBe("github_mcp");
  });

  it("collapses non-alphanumeric chars", () => {
    expect(getServerSlug("Google -- Workspace")).toBe("google_workspace");
  });

  it("trims leading/trailing underscores", () => {
    expect(getServerSlug("  --hello-- ")).toBe("hello");
  });

  it("truncates to 30 chars", () => {
    const long = "a".repeat(50);
    expect(getServerSlug(long).length).toBe(30);
  });
});

// ── validateCommand ──────────────────────────────────────────────────────

describe("validateCommand", () => {
  it("returns null for safe commands", () => {
    expect(validateCommand("npx")).toBeNull();
    expect(validateCommand("node")).toBeNull();
    expect(validateCommand("/usr/bin/python3")).toBeNull();
  });

  it("rejects shell metacharacters", () => {
    expect(validateCommand("npx; rm -rf /")).not.toBeNull();
    expect(validateCommand("cmd | evil")).not.toBeNull();
    expect(validateCommand("cmd && evil")).not.toBeNull();
    expect(validateCommand("$(evil)")).not.toBeNull();
    expect(validateCommand("`evil`")).not.toBeNull();
  });
});

// ── createMcpServer ──────────────────────────────────────────────────────

describe("createMcpServer", () => {
  it("inserts server with encrypted env vars", async () => {
    const fakeRow = {
      id: "srv-1",
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      url: null,
      envVars: 'encrypted:{"GITHUB_TOKEN":"ghp_abc"}',
      status: "unknown",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockReturning.mockResolvedValueOnce([fakeRow]);

    const result = await createMcpServer({
      name: "GitHub",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      envVars: { GITHUB_TOKEN: "ghp_abc" },
    });

    expect(result.id).toBe("srv-1");
    expect(result.name).toBe("GitHub");
    expect(encrypt).toHaveBeenCalledWith('{"GITHUB_TOKEN":"ghp_abc"}');
  });

  it("inserts server without env vars when empty", async () => {
    const fakeRow = {
      id: "srv-2",
      name: "Test",
      transport: "http",
      command: null,
      args: [],
      url: "https://example.com",
      envVars: null,
      status: "unknown",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockReturning.mockResolvedValueOnce([fakeRow]);

    await createMcpServer({
      name: "Test",
      transport: "http",
      url: "https://example.com",
    });

    expect(mockValues).toHaveBeenCalledWith(expect.objectContaining({ envVars: null }));
  });
});

// ── updateMcpServer ──────────────────────────────────────────────────────

describe("updateMcpServer", () => {
  it("re-encrypts env vars when updated", async () => {
    const fakeRow = {
      id: "srv-1",
      name: "GitHub Updated",
      transport: "stdio",
      command: "npx",
      args: [],
      url: null,
      envVars: 'encrypted:{"NEW_TOKEN":"abc"}',
      status: "unknown",
      statusMessage: null,
      lastCheckedAt: null,
      toolManifest: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockUpdateReturning.mockResolvedValueOnce([fakeRow]);

    const result = await updateMcpServer("srv-1", {
      name: "GitHub Updated",
      envVars: { NEW_TOKEN: "abc" },
    });

    expect(result?.name).toBe("GitHub Updated");
    expect(encrypt).toHaveBeenCalledWith('{"NEW_TOKEN":"abc"}');
  });

  it("returns null when server not found", async () => {
    mockUpdateReturning.mockResolvedValueOnce([]);

    const result = await updateMcpServer("nonexistent", { name: "Foo" });
    expect(result).toBeNull();
  });
});

// ── deleteMcpServer ──────────────────────────────────────────────────────

describe("deleteMcpServer", () => {
  it("strips mcp tools from agents before deleting", async () => {
    // First select: list all agents
    mockSelectFrom.mockReturnValueOnce(
      Promise.resolve([
        {
          id: "agent-1",
          allowedTools: ["shell", "mcp:srv-1:create_issue", "mcp:srv-1:list_repos", "pinchy_ls"],
        },
        {
          id: "agent-2",
          allowedTools: ["mcp:srv-2:other_tool"],
        },
      ])
    );

    mockDeleteReturning.mockResolvedValueOnce([
      {
        id: "srv-1",
        name: "GitHub",
        transport: "stdio",
        command: "npx",
        args: [],
        url: null,
        envVars: null,
        status: "connected",
        statusMessage: null,
        lastCheckedAt: null,
        toolManifest: [{ name: "create_issue", description: "", inputSchema: {} }],
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await deleteMcpServer("srv-1");

    expect(result?.id).toBe("srv-1");
    // Should have called update for agent-1 (had mcp:srv-1:* tools)
    // agent-2 only has mcp:srv-2 so should NOT be updated
    expect(mockUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["shell", "pinchy_ls"],
      })
    );
  });
});

// ── listMcpServers ───────────────────────────────────────────────────────

describe("listMcpServers", () => {
  it("returns servers with env var keys (not values)", async () => {
    mockSelectFrom.mockReturnValueOnce(
      Promise.resolve([
        {
          id: "srv-1",
          name: "GitHub",
          transport: "stdio",
          command: "npx",
          args: [],
          url: null,
          envVars: 'encrypted:{"GITHUB_TOKEN":"secret","OTHER":"val"}',
          status: "connected",
          statusMessage: null,
          lastCheckedAt: null,
          toolManifest: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
    );

    const servers = await listMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].envVarKeys).toEqual(["GITHUB_TOKEN", "OTHER"]);
  });
});

// ── getMcpToolDefinitions ────────────────────────────────────────────────

describe("getMcpToolDefinitions", () => {
  it("returns tool definitions with mcp category", async () => {
    mockSelectFrom.mockReturnValueOnce(
      Promise.resolve([
        {
          id: "srv-1",
          name: "GitHub MCP",
          transport: "stdio",
          command: "npx",
          args: [],
          url: null,
          envVars: null,
          status: "connected",
          statusMessage: null,
          lastCheckedAt: null,
          toolManifest: [
            { name: "create_issue", description: "Create a GitHub issue", inputSchema: {} },
            { name: "list_repos", description: "List repos", inputSchema: {} },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "srv-2",
          name: "No Tools Server",
          transport: "http",
          command: null,
          args: [],
          url: "https://example.com",
          envVars: null,
          status: "unknown",
          statusMessage: null,
          lastCheckedAt: null,
          toolManifest: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ])
    );

    const tools = await getMcpToolDefinitions();
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({
      id: "mcp:srv-1:create_issue",
      label: "create_issue",
      description: "Create a GitHub issue",
      category: "mcp",
      serverName: "GitHub MCP",
    });
    expect(tools[1].id).toBe("mcp:srv-1:list_repos");
  });
});

// ── buildMcporterServerConfig ────────────────────────────────────────────

describe("buildMcporterServerConfig", () => {
  it("builds stdio config", () => {
    const config = buildMcporterServerConfig(
      {
        name: "GitHub",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@mcp/server-github"],
        url: null,
        envVars: null,
      },
      { GITHUB_TOKEN: "ghp_abc" }
    );

    expect(config).toEqual({
      command: "npx",
      args: ["-y", "@mcp/server-github"],
      env: { GITHUB_TOKEN: "ghp_abc" },
    });
  });

  it("builds http config", () => {
    const config = buildMcporterServerConfig(
      {
        name: "Workspace",
        transport: "http",
        command: null,
        args: [],
        url: "https://workspace-mcp.example.com",
        envVars: null,
      },
      {}
    );

    expect(config).toEqual({
      baseUrl: "https://workspace-mcp.example.com",
    });
  });

  it("omits env when empty", () => {
    const config = buildMcporterServerConfig(
      {
        name: "Test",
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        url: null,
        envVars: null,
      },
      {}
    );

    expect(config).not.toHaveProperty("env");
  });
});

// ── decryptEnvVars ───────────────────────────────────────────────────────

describe("decryptEnvVars", () => {
  it("returns empty object for null", () => {
    expect(decryptEnvVars(null)).toEqual({});
  });

  it("decrypts and parses env vars", () => {
    const result = decryptEnvVars('encrypted:{"KEY":"value"}');
    expect(result).toEqual({ KEY: "value" });
  });

  it("returns empty object on decrypt failure", () => {
    vi.mocked(decrypt).mockImplementationOnce(() => {
      throw new Error("bad ciphertext");
    });
    expect(decryptEnvVars("garbage")).toEqual({});
  });
});
