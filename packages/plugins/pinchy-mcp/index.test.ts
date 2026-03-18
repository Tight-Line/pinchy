import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock mcporter
vi.mock("mcporter", () => ({
  createRuntime: vi.fn().mockResolvedValue({
    callTool: vi.fn().mockResolvedValue({ text: "tool result" }),
    close: vi.fn().mockResolvedValue(undefined),
  }),
}));

import plugin from "./index";

interface RegisteredFactory {
  name: string;
  factory: (ctx: { agentId?: string }) => unknown;
}

function createMockApi(config: unknown) {
  const registeredTools: RegisteredFactory[] = [];

  return {
    pluginConfig: config,
    registerTool: vi.fn(
      (factory: (ctx: { agentId?: string }) => unknown, opts?: { name?: string }) => {
        registeredTools.push({ name: opts?.name ?? "unnamed", factory });
      }
    ),
    registeredTools,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("pinchy-mcp plugin", () => {
  it("has correct id and name", () => {
    expect(plugin.id).toBe("pinchy-mcp");
    expect(plugin.name).toBe("Pinchy MCP");
  });

  it("validates config schema", () => {
    expect(plugin.configSchema.validate(null)).toEqual(
      expect.objectContaining({ ok: false })
    );
    expect(
      plugin.configSchema.validate({ mcporterConfigPath: "/path", agents: {} })
    ).toEqual(expect.objectContaining({ ok: true }));
  });

  it("skips registration when no config provided", () => {
    const api = createMockApi(undefined);
    plugin.register(api);
    expect(api.registerTool).not.toHaveBeenCalled();
  });

  it("registers tools from agent config", () => {
    const api = createMockApi({
      mcporterConfigPath: "/config/mcporter.json",
      agents: {
        "agent-1": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
            { serverId: "srv-1", serverSlug: "github", toolName: "list_repos" },
          ],
        },
      },
    });

    plugin.register(api);

    expect(api.registerTool).toHaveBeenCalledTimes(2);
    expect(api.registeredTools.map((t) => t.name)).toContain("mcp_github_create_issue");
    expect(api.registeredTools.map((t) => t.name)).toContain("mcp_github_list_repos");
  });

  it("factory returns null for unauthorized agent", () => {
    const api = createMockApi({
      mcporterConfigPath: "/config/mcporter.json",
      agents: {
        "agent-1": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
          ],
        },
      },
    });

    plugin.register(api);

    const factory = api.registeredTools[0].factory;

    // Authorized agent
    expect(factory({ agentId: "agent-1" })).not.toBeNull();

    // Unauthorized agent
    expect(factory({ agentId: "agent-2" })).toBeNull();

    // No agent ID
    expect(factory({})).toBeNull();
  });

  it("deduplicates tools shared across agents", () => {
    const api = createMockApi({
      mcporterConfigPath: "/config/mcporter.json",
      agents: {
        "agent-1": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
          ],
        },
        "agent-2": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
          ],
        },
      },
    });

    plugin.register(api);

    // Only one tool registered (not two)
    expect(api.registerTool).toHaveBeenCalledTimes(1);

    const factory = api.registeredTools[0].factory;
    // Both agents can use it
    expect(factory({ agentId: "agent-1" })).not.toBeNull();
    expect(factory({ agentId: "agent-2" })).not.toBeNull();
  });

  it("tool execute returns text content on success", async () => {
    const api = createMockApi({
      mcporterConfigPath: "/config/mcporter.json",
      agents: {
        "agent-1": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
          ],
        },
      },
    });

    plugin.register(api);

    const tool = api.registeredTools[0].factory({ agentId: "agent-1" }) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    };

    const result = await tool.execute("call-1", { args: { title: "Bug" } });
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
  });

  it("tool execute returns error text on failure (never throws)", async () => {
    // Override mcporter mock to throw
    const mcporter = await import("mcporter");
    vi.mocked(mcporter.createRuntime).mockResolvedValueOnce({
      callTool: vi.fn().mockRejectedValue(new Error("Connection refused")),
      close: vi.fn(),
    } as never);

    const api = createMockApi({
      mcporterConfigPath: "/config/mcporter.json",
      agents: {
        "agent-1": {
          allowedMcpTools: [
            { serverId: "srv-1", serverSlug: "github", toolName: "create_issue" },
          ],
        },
      },
    });

    plugin.register(api);

    const tool = api.registeredTools[0].factory({ agentId: "agent-1" }) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<{
        content: Array<{ type: string; text: string }>;
      }>;
    };

    // Should NOT throw — returns error text
    const result = await tool.execute("call-1", {});
    expect(result.content[0].text).toContain("Error calling MCP tool");
    expect(result.content[0].text).toContain("Connection refused");
  });
});
