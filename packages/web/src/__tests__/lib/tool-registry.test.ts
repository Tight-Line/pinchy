import { describe, it, expect, vi } from "vitest";
import {
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  computeDeniedGroups,
} from "@/lib/tool-registry";

describe("TOOL_REGISTRY", () => {
  it("contains safe tools", () => {
    const safe = TOOL_REGISTRY.filter((t) => t.category === "safe");
    expect(safe.length).toBeGreaterThanOrEqual(2);
    expect(safe.map((t) => t.id)).toContain("pinchy_ls");
    expect(safe.map((t) => t.id)).toContain("pinchy_read");
  });

  it("contains powerful tools", () => {
    const powerful = TOOL_REGISTRY.filter((t) => t.category === "powerful");
    expect(powerful.length).toBeGreaterThanOrEqual(5);
  });

  it("every tool has id, label, description, and category", () => {
    for (const tool of TOOL_REGISTRY) {
      expect(tool.id).toBeTruthy();
      expect(tool.label).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(["safe", "powerful"]).toContain(tool.category);
    }
  });

  it("has unique tool IDs", () => {
    const ids = TOOL_REGISTRY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getToolById", () => {
  it("returns a tool by ID", () => {
    const tool = getToolById("pinchy_ls");
    expect(tool?.label).toBe("List approved directories");
  });

  it("returns undefined for unknown ID", () => {
    expect(getToolById("nonexistent")).toBeUndefined();
  });

  it("returns undefined for MCP tool IDs (not in static registry)", () => {
    expect(getToolById("mcp:srv-1:create_issue")).toBeUndefined();
  });
});

describe("getToolsByCategory", () => {
  it("returns only safe tools", () => {
    const safe = getToolsByCategory("safe");
    expect(safe.every((t) => t.category === "safe")).toBe(true);
  });

  it("returns only powerful tools", () => {
    const powerful = getToolsByCategory("powerful");
    expect(powerful.every((t) => t.category === "powerful")).toBe(true);
  });
});

describe("computeDeniedGroups", () => {
  it("returns empty deny list when no tools are allowed", () => {
    const denied = computeDeniedGroups([]);
    expect(denied).toContain("group:runtime");
    expect(denied).toContain("group:fs");
    expect(denied).toContain("group:web");
  });

  it("removes group from deny list when a tool from that group is allowed", () => {
    const denied = computeDeniedGroups(["shell"]);
    expect(denied).not.toContain("group:runtime");
    expect(denied).toContain("group:fs");
    expect(denied).toContain("group:web");
  });

  it("removes fs group when any fs tool is allowed", () => {
    const denied = computeDeniedGroups(["fs_read"]);
    expect(denied).not.toContain("group:fs");
  });

  it("ignores safe tools for group computation", () => {
    const denied = computeDeniedGroups(["pinchy_ls", "pinchy_read"]);
    expect(denied).toContain("group:runtime");
    expect(denied).toContain("group:fs");
    expect(denied).toContain("group:web");
  });

  it("ignores MCP tools for group computation", () => {
    const denied = computeDeniedGroups(["mcp:srv-1:create_issue", "mcp:srv-2:search"]);
    expect(denied).toContain("group:runtime");
    expect(denied).toContain("group:fs");
    expect(denied).toContain("group:web");
  });
});

describe("getAllToolDefinitions", () => {
  it("merges static and MCP tools", async () => {
    vi.doMock("@/lib/mcp-servers", () => ({
      getMcpToolDefinitions: vi.fn().mockResolvedValue([
        {
          id: "mcp:srv-1:create_issue",
          label: "create_issue",
          description: "Create issue",
          category: "mcp",
          serverName: "GitHub",
        },
      ]),
    }));

    // Re-import to pick up mock
    const { getAllToolDefinitions: getAllFresh } = await import("@/lib/tool-registry");
    const tools = await getAllFresh();

    expect(tools.length).toBe(TOOL_REGISTRY.length + 1);
    expect(tools.find((t) => t.id === "mcp:srv-1:create_issue")).toBeDefined();
    expect(tools.find((t) => t.id === "pinchy_ls")).toBeDefined();

    vi.doUnmock("@/lib/mcp-servers");
  });
});
