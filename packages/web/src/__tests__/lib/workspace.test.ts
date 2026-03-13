import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBackend = {
  readConfig: vi.fn().mockResolvedValue({}),
  writeConfig: vi.fn().mockResolvedValue(undefined),
  notifyConfigChanged: vi.fn().mockResolvedValue(undefined),
  ensureAgentWorkspace: vi.fn().mockResolvedValue(undefined),
  writeAgentFile: vi.fn().mockResolvedValue(undefined),
  readAgentFile: vi.fn().mockResolvedValue(""),
  deleteAgentWorkspace: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/lib/openclaw-backend", () => ({
  getBackend: () => mockBackend,
}));

import type { WorkspaceFile } from "@/lib/workspace";
import {
  ALLOWED_FILES,
  getOpenClawWorkspacePath,
  ensureWorkspace,
  readWorkspaceFile,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  generateIdentityContent,
  writeIdentityFile,
} from "@/lib/workspace";

describe("ALLOWED_FILES", () => {
  it("should contain SOUL.md and AGENTS.md (not USER.md)", () => {
    expect(ALLOWED_FILES).toEqual(["SOUL.md", "AGENTS.md"]);
  });

  it("should be a readonly array", () => {
    expect(Array.isArray(ALLOWED_FILES)).toBe(true);
  });
});

describe("WorkspaceFile type", () => {
  it("should be assignable from ALLOWED_FILES entries", () => {
    const file: WorkspaceFile = ALLOWED_FILES[0];
    expect(file).toBe("SOUL.md");
  });
});

describe("agentId validation", () => {
  it("should reject agentId containing forward slash", () => {
    expect(() => getOpenClawWorkspacePath("../../etc/cron.d")).toThrow(
      "Invalid agentId: ../../etc/cron.d"
    );
  });

  it("should reject agentId containing backslash", () => {
    expect(() => getOpenClawWorkspacePath("..\\etc\\passwd")).toThrow(
      "Invalid agentId: ..\\etc\\passwd"
    );
  });

  it("should reject agentId containing ..", () => {
    expect(() => getOpenClawWorkspacePath("..")).toThrow("Invalid agentId: ..");
  });

  it("should reject empty agentId", () => {
    expect(() => getOpenClawWorkspacePath("")).toThrow("Invalid agentId: ");
  });

  it("should reject path traversal in ensureWorkspace", async () => {
    await expect(ensureWorkspace("../evil")).rejects.toThrow("Invalid agentId: ../evil");
  });

  it("should reject path traversal in readWorkspaceFile", async () => {
    await expect(readWorkspaceFile("../../etc", "SOUL.md")).rejects.toThrow(
      "Invalid agentId: ../../etc"
    );
  });

  it("should reject path traversal in writeWorkspaceFile", async () => {
    await expect(writeWorkspaceFile("../hack", "SOUL.md", "content")).rejects.toThrow(
      "Invalid agentId: ../hack"
    );
  });

  it("should accept valid agentId", () => {
    const path = getOpenClawWorkspacePath("agent-123");
    expect(path).toBe("/root/.openclaw/workspaces/agent-123");
  });

  it("should accept agentId with UUID format", () => {
    const path = getOpenClawWorkspacePath("550e8400-e29b-41d4-a716-446655440000");
    expect(path).toBe("/root/.openclaw/workspaces/550e8400-e29b-41d4-a716-446655440000");
  });
});

describe("getOpenClawWorkspacePath", () => {
  it("should return OpenClaw workspace path for agent", () => {
    const path = getOpenClawWorkspacePath("550e8400-e29b-41d4-a716-446655440000");
    expect(path).toBe("/root/.openclaw/workspaces/550e8400-e29b-41d4-a716-446655440000");
  });

  it("should use OPENCLAW_WORKSPACE_PREFIX env var when set", () => {
    const originalEnv = process.env.OPENCLAW_WORKSPACE_PREFIX;
    process.env.OPENCLAW_WORKSPACE_PREFIX = "/custom/openclaw/workspaces";

    const path = getOpenClawWorkspacePath("agent-456");
    expect(path).toBe("/custom/openclaw/workspaces/agent-456");

    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_WORKSPACE_PREFIX;
    } else {
      process.env.OPENCLAW_WORKSPACE_PREFIX = originalEnv;
    }
  });

  it("should reject invalid agentId", () => {
    expect(() => getOpenClawWorkspacePath("../evil")).toThrow("Invalid agentId: ../evil");
  });
});

describe("ensureWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackend.readAgentFile.mockResolvedValue("");
  });

  it("should call ensureAgentWorkspace on the backend", async () => {
    await ensureWorkspace("agent-123");

    expect(mockBackend.ensureAgentWorkspace).toHaveBeenCalledWith("agent-123");
  });

  it("should create SOUL.md with placeholder content when missing", async () => {
    await ensureWorkspace("agent-123");

    const soulCall = mockBackend.writeAgentFile.mock.calls.find(
      (call: unknown[]) => call[1] === "SOUL.md"
    );
    expect(soulCall).toBeDefined();
    expect(soulCall![0]).toBe("agent-123");
    expect(soulCall![2]).toContain("Describe your agent's personality here");
  });

  it("should not create USER.md placeholder", async () => {
    await ensureWorkspace("agent-123");

    const userCall = mockBackend.writeAgentFile.mock.calls.find(
      (call: unknown[]) => call[1] === "USER.md"
    );
    expect(userCall).toBeUndefined();
  });

  it("should not overwrite existing SOUL.md", async () => {
    mockBackend.readAgentFile.mockImplementation(async (_id: string, filename: string) => {
      return filename === "SOUL.md" ? "existing content" : "";
    });

    await ensureWorkspace("agent-123");

    const soulCall = mockBackend.writeAgentFile.mock.calls.find(
      (call: unknown[]) => call[1] === "SOUL.md"
    );
    expect(soulCall).toBeUndefined();
  });

  it("should create AGENTS.md with placeholder content when missing", async () => {
    await ensureWorkspace("agent-123");

    const agentsCall = mockBackend.writeAgentFile.mock.calls.find(
      (call: unknown[]) => call[1] === "AGENTS.md"
    );
    expect(agentsCall).toBeDefined();
    expect(agentsCall![0]).toBe("agent-123");
    expect(agentsCall![2]).toContain("Define your agent's instructions here");
  });

  it("should not overwrite existing AGENTS.md", async () => {
    mockBackend.readAgentFile.mockImplementation(async (_id: string, filename: string) => {
      return filename === "AGENTS.md" ? "existing content" : "";
    });

    await ensureWorkspace("agent-123");

    const agentsCall = mockBackend.writeAgentFile.mock.calls.find(
      (call: unknown[]) => call[1] === "AGENTS.md"
    );
    expect(agentsCall).toBeUndefined();
  });
});

describe("readWorkspaceFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should read SOUL.md content via backend", async () => {
    mockBackend.readAgentFile.mockResolvedValue("You are a helpful assistant.");

    const content = await readWorkspaceFile("agent-123", "SOUL.md");

    expect(mockBackend.readAgentFile).toHaveBeenCalledWith("agent-123", "SOUL.md");
    expect(content).toBe("You are a helpful assistant.");
  });

  it("should throw on USER.md (no longer in ALLOWED_FILES)", async () => {
    await expect(readWorkspaceFile("agent-123", "USER.md")).rejects.toThrow(
      "File not allowed: USER.md"
    );
  });

  it("should read AGENTS.md content", async () => {
    mockBackend.readAgentFile.mockResolvedValue("Answer questions about HR policies.");

    const content = await readWorkspaceFile("agent-123", "AGENTS.md");

    expect(mockBackend.readAgentFile).toHaveBeenCalledWith("agent-123", "AGENTS.md");
    expect(content).toBe("Answer questions about HR policies.");
  });

  it("should return empty string if file does not exist", async () => {
    mockBackend.readAgentFile.mockResolvedValue("");

    const content = await readWorkspaceFile("agent-123", "SOUL.md");
    expect(content).toBe("");
  });

  it("should throw on disallowed filename", async () => {
    await expect(readWorkspaceFile("agent-123", "SECRET.md")).rejects.toThrow(
      "File not allowed: SECRET.md"
    );
  });

  it("should throw on path traversal attempt with ../", async () => {
    await expect(readWorkspaceFile("agent-123", "../etc/passwd")).rejects.toThrow(
      "File not allowed: ../etc/passwd"
    );
  });

  it("should throw on path traversal attempt with subdirectory", async () => {
    await expect(readWorkspaceFile("agent-123", "subdir/SOUL.md")).rejects.toThrow(
      "File not allowed: subdir/SOUL.md"
    );
  });

  it("should throw on empty filename", async () => {
    await expect(readWorkspaceFile("agent-123", "")).rejects.toThrow("File not allowed: ");
  });
});

describe("writeWorkspaceFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write content to SOUL.md via backend", async () => {
    await writeWorkspaceFile("agent-123", "SOUL.md", "You are a project manager.");

    expect(mockBackend.writeAgentFile).toHaveBeenCalledWith(
      "agent-123",
      "SOUL.md",
      "You are a project manager."
    );
  });

  it("should throw on USER.md (no longer in ALLOWED_FILES)", async () => {
    await expect(writeWorkspaceFile("agent-123", "USER.md", "content")).rejects.toThrow(
      "File not allowed: USER.md"
    );
  });

  it("should write content to AGENTS.md", async () => {
    await writeWorkspaceFile("agent-123", "AGENTS.md", "Answer questions about HR policies.");

    expect(mockBackend.writeAgentFile).toHaveBeenCalledWith(
      "agent-123",
      "AGENTS.md",
      "Answer questions about HR policies."
    );
  });

  it("should throw on disallowed filename", async () => {
    await expect(writeWorkspaceFile("agent-123", "HACK.md", "malicious")).rejects.toThrow(
      "File not allowed: HACK.md"
    );
  });

  it("should throw on path traversal attempt", async () => {
    await expect(writeWorkspaceFile("agent-123", "../../etc/passwd", "pwned")).rejects.toThrow(
      "File not allowed: ../../etc/passwd"
    );
  });

  it("should throw on filename with directory separator", async () => {
    await expect(writeWorkspaceFile("agent-123", "foo/SOUL.md", "content")).rejects.toThrow(
      "File not allowed: foo/SOUL.md"
    );
  });

  it("should not write file when filename is disallowed", async () => {
    try {
      await writeWorkspaceFile("agent-123", "EVIL.md", "content");
    } catch {
      // expected
    }

    expect(mockBackend.writeAgentFile).not.toHaveBeenCalled();
  });
});

describe("generateIdentityContent", () => {
  it("should return markdown with name heading and tagline", () => {
    const result = generateIdentityContent({
      name: "Smithers",
      tagline: "Your reliable personal assistant",
    });
    expect(result).toBe("# Smithers\n> Your reliable personal assistant");
  });

  it("should return only name heading when tagline is null", () => {
    const result = generateIdentityContent({ name: "Custom Agent", tagline: null });
    expect(result).toBe("# Custom Agent");
  });
});

describe("writeIdentityFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write IDENTITY.md to workspace via backend", async () => {
    await writeIdentityFile("agent-123", {
      name: "Smithers",
      tagline: "Your reliable personal assistant",
    });

    expect(mockBackend.writeAgentFile).toHaveBeenCalledWith(
      "agent-123",
      "IDENTITY.md",
      "# Smithers\n> Your reliable personal assistant"
    );
  });

  it("should write only name heading when tagline is null", async () => {
    await writeIdentityFile("agent-123", { name: "Custom Agent", tagline: null });

    expect(mockBackend.writeAgentFile).toHaveBeenCalledWith(
      "agent-123",
      "IDENTITY.md",
      "# Custom Agent"
    );
  });

  it("should reject invalid agentId", async () => {
    await expect(writeIdentityFile("../evil", { name: "Evil", tagline: null })).rejects.toThrow(
      "Invalid agentId: ../evil"
    );
  });

  it("should not be accessible via readWorkspaceFile", async () => {
    await expect(readWorkspaceFile("agent-123", "IDENTITY.md")).rejects.toThrow(
      "File not allowed: IDENTITY.md"
    );
  });

  it("should not be accessible via writeWorkspaceFile", async () => {
    await expect(writeWorkspaceFile("agent-123", "IDENTITY.md", "content")).rejects.toThrow(
      "File not allowed: IDENTITY.md"
    );
  });
});

describe("writeWorkspaceFileInternal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should write USER.md bypassing ALLOWED_FILES check", async () => {
    await writeWorkspaceFileInternal("agent-123", "USER.md", "org context content");

    expect(mockBackend.writeAgentFile).toHaveBeenCalledWith(
      "agent-123",
      "USER.md",
      "org context content"
    );
  });

  it("should reject invalid agentId with path traversal", async () => {
    await expect(writeWorkspaceFileInternal("../evil", "USER.md", "content")).rejects.toThrow(
      "Invalid agentId: ../evil"
    );
  });

  it("should reject empty agentId", async () => {
    await expect(writeWorkspaceFileInternal("", "USER.md", "content")).rejects.toThrow(
      "Invalid agentId: "
    );
  });
});
