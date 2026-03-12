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

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    }),
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/server/restart-state", () => ({
  restartState: { notifyRestart: vi.fn() },
}));

vi.mock("@/lib/migrate-onboarding", () => ({
  migrateExistingSmithers: vi.fn().mockResolvedValue(undefined),
}));

import { writeOpenClawConfig, regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

const mockedDb = vi.mocked(db);
const mockedGetSetting = vi.mocked(getSetting);

describe("writeOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackend.readConfig.mockResolvedValue({});
  });

  it("should write config with Anthropic provider", async () => {
    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-secret",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(mockBackend.writeConfig).toHaveBeenCalledOnce();
    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
  });

  it("should write config with correct model", async () => {
    await writeOpenClawConfig({
      provider: "openai",
      apiKey: "sk-key",
      model: "openai/gpt-4o-mini",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o-mini");
    expect(config.env.OPENAI_API_KEY).toBe("sk-key");
  });

  it("should include gateway mode local and bind lan", async () => {
    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("should write config with Google provider", async () => {
    await writeOpenClawConfig({
      provider: "google",
      apiKey: "AIza-key",
      model: "google/gemini-2.0-flash",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.env.GOOGLE_API_KEY).toBe("AIza-key");
    expect(config.agents.defaults.model.primary).toBe("google/gemini-2.0-flash");
  });

  it("should generate auth token when no existing config", async () => {
    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.gateway.auth).toBeDefined();
    expect(config.gateway.auth.mode).toBe("token");
    expect(config.gateway.auth.token).toBeTruthy();
    expect(config.gateway.auth.token).toHaveLength(48); // 24 bytes hex
  });

  it("should merge with existing config preserving gateway.auth", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "existing-secret-token" },
      },
      meta: {
        version: "1.2.3",
        generatedAt: "2025-01-01T00:00:00Z",
      },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-sonnet-4-20250514" },
        },
      },
    });

    await writeOpenClawConfig({
      provider: "openai",
      apiKey: "sk-new-key",
      model: "openai/gpt-4o",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];

    // Pinchy's fields are applied
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
    expect(config.env.OPENAI_API_KEY).toBe("sk-new-key");
    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o");

    // OpenClaw's auto-generated fields are preserved
    expect(config.gateway.auth.token).toBe("existing-secret-token");
    expect(config.meta.version).toBe("1.2.3");
    expect(config.meta.generatedAt).toBe("2025-01-01T00:00:00Z");
  });

  it("should notify config changed after writing", async () => {
    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(mockBackend.notifyConfigChanged).toHaveBeenCalledOnce();
  });

  it("should create config from scratch when no existing config", async () => {
    mockBackend.readConfig.mockResolvedValue({});

    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-fresh",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    const config = mockBackend.writeConfig.mock.calls[0][0];
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-fresh");
    expect(config.agents.defaults.model.primary).toBe("anthropic/claude-haiku-4-5-20251001");
  });
});

describe("regenerateOpenClawConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackend.readConfig.mockResolvedValue({});
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("should write agents.list with all agents from DB", async () => {
    const agentsData = [
      {
        id: "uuid-agent-1",
        name: "Smithers",
        model: "anthropic/claude-opus-4-6",
        createdAt: new Date(),
      },
      {
        id: "uuid-agent-2",
        name: "Jeeves",
        model: "openai/gpt-4o",
        createdAt: new Date(),
      },
    ];
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue(agentsData),
    } as never);

    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.agents.list).toHaveLength(2);
    expect(config.agents.list[0]).toEqual({
      id: "uuid-agent-1",
      name: "Smithers",
      model: "anthropic/claude-opus-4-6",
      workspace: "/root/.openclaw/workspaces/uuid-agent-1",
      tools: { deny: ["group:runtime", "group:fs", "group:web"] },
    });
    expect(config.agents.list[1]).toEqual({
      id: "uuid-agent-2",
      name: "Jeeves",
      model: "openai/gpt-4o",
      workspace: "/root/.openclaw/workspaces/uuid-agent-2",
      tools: { deny: ["group:runtime", "group:fs", "group:web"] },
    });
  });

  it("should preserve existing gateway.auth fields", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "existing-secret-token" },
      },
      meta: {
        version: "1.2.3",
        generatedAt: "2025-01-01T00:00:00Z",
      },
    });

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.gateway.auth.token).toBe("existing-secret-token");
    // Only gateway block is preserved — other top-level fields (meta, etc.) are rebuilt from DB
    expect(config.meta).toBeUndefined();
    expect(config.gateway.mode).toBe("local");
    expect(config.gateway.bind).toBe("lan");
  });

  it("should include provider env vars from settings", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-decrypted";
      if (key === "openai_api_key") return "sk-openai-decrypted";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-decrypted");
    expect(config.env.OPENAI_API_KEY).toBe("sk-openai-decrypted");
    expect(config.env.GOOGLE_API_KEY).toBeUndefined();
  });

  it("should set defaults.model from default provider", async () => {
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "default_provider") return "openai";
      if (key === "openai_api_key") return "sk-openai-key";
      return null;
    });

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.agents.defaults.model.primary).toBe("openai/gpt-4o-mini");
  });

  it("should handle empty agents list", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.agents.list).toEqual([]);
  });

  it("should handle no configured providers", async () => {
    mockedGetSetting.mockResolvedValue(null);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.env).toEqual({});
    expect(config.agents.defaults).toEqual({});
  });

  it("should deny all groups for agents with only safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];
    const kbAgent = config.agents.list.find((a: { id: string }) => a.id === "kb-agent-id");

    expect(kbAgent.tools).toBeDefined();
    expect(kbAgent.tools.deny).toContain("group:runtime");
    expect(kbAgent.tools.deny).toContain("group:fs");
    expect(kbAgent.tools.deny).toContain("group:web");
    expect(kbAgent.tools.allow).toBeUndefined();
  });

  it("should deny all groups for agents with empty allowedTools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          allowedTools: [],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];
    const customAgent = config.agents.list.find((a: { id: string }) => a.id === "custom-agent-id");

    expect(customAgent.tools).toBeDefined();
    expect(customAgent.tools.deny).toContain("group:runtime");
    expect(customAgent.tools.deny).toContain("group:fs");
    expect(customAgent.tools.deny).toContain("group:web");
  });

  it("should not deny group:runtime when shell is allowed", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "power-agent-id",
          name: "Power Agent",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          allowedTools: ["shell", "pinchy_ls"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];
    const agent = config.agents.list.find((a: { id: string }) => a.id === "power-agent-id");

    expect(agent.tools.deny).not.toContain("group:runtime");
    expect(agent.tools.deny).toContain("group:fs");
    expect(agent.tools.deny).toContain("group:web");
  });

  it("should include pinchy-files plugin config for agents with safe tools", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "kb-agent-id",
          name: "HR Knowledge Base",
          model: "anthropic/claude-haiku-4-5-20251001",
          templateId: "knowledge-base",
          pluginConfig: { allowed_paths: ["/data/hr-docs/", "/data/policies/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-files"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-files"].config.agents["kb-agent-id"]).toEqual({
      allowed_paths: ["/data/hr-docs/", "/data/policies/"],
    });
  });

  it("should not keep stale env vars from previous config", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: {
        mode: "local",
        bind: "lan",
        auth: { token: "existing-token" },
      },
      env: {
        ANTHROPIC_API_KEY: "old-key",
        OPENAI_API_KEY: "stale-key-should-be-removed",
      },
    });

    // Only Anthropic is configured now
    mockedGetSetting.mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-new";
      if (key === "default_provider") return "anthropic";
      return null;
    });

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.env.ANTHROPIC_API_KEY).toBe("sk-ant-new");
    expect(config.env.OPENAI_API_KEY).toBeUndefined();
    expect(config.gateway.auth.token).toBe("existing-token");
  });

  it("should include pinchy-context plugin config for agents with context tools", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    });
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "gateway_token" ? "gw-token-123" : null
    );

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-context"].config.apiBaseUrl).toBe("http://pinchy:7777");
    expect(config.plugins.entries["pinchy-context"].config.gatewayToken).toBe("gw-token-123");
    expect(config.plugins.entries["pinchy-context"].config.agents["smithers-1"]).toEqual({
      tools: ["save_user_context"],
      userId: "user-1",
    });
  });

  it("should include pinchy-audit plugin config", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token-123" } },
    });
    mockedGetSetting.mockImplementation(async (key: string) =>
      key === "gateway_token" ? "gw-token-123" : null
    );

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.plugins.entries["pinchy-audit"]).toBeDefined();
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.entries["pinchy-audit"].config).toEqual({
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "gw-token-123",
    });
  });

  it("should include both pinchy-files and pinchy-context when agents use both", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    });

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "smithers-1",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context"],
          ownerId: "user-1",
          isPersonal: true,
          createdAt: new Date(),
        },
        {
          id: "kb-agent",
          name: "KB Agent",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: { allowed_paths: ["/data/docs/"] },
          allowedTools: ["pinchy_ls", "pinchy_read"],
          ownerId: null,
          isPersonal: false,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.plugins.entries["pinchy-files"]).toBeDefined();
    expect(config.plugins.entries["pinchy-context"]).toBeDefined();
  });

  it("should include both save tools for admin Smithers", async () => {
    mockBackend.readConfig.mockResolvedValue({
      gateway: { mode: "local", bind: "lan", auth: { token: "gw-token" } },
    });

    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "admin-smithers",
          name: "Smithers",
          model: "anthropic/claude-sonnet-4-20250514",
          pluginConfig: null,
          allowedTools: ["pinchy_save_user_context", "pinchy_save_org_context"],
          ownerId: "admin-1",
          isPersonal: true,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    expect(config.plugins.entries["pinchy-context"].config.agents["admin-smithers"]).toEqual({
      tools: ["save_user_context", "save_org_context"],
      userId: "admin-1",
    });
  });

  it("should omit pinchy-context and pinchy-files when no agents use them", async () => {
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([
        {
          id: "custom-agent-id",
          name: "Dev Assistant",
          model: "anthropic/claude-opus-4-6",
          templateId: "custom",
          pluginConfig: null,
          createdAt: new Date(),
        },
      ]),
    } as never);

    await regenerateOpenClawConfig();

    const config = mockBackend.writeConfig.mock.calls[0][0];

    // Unused plugins are omitted from entries AND allow list to prevent
    // auto-discovery (restart loop) and "disabled but config present" spam
    expect(config.plugins.entries["pinchy-context"]).toBeUndefined();
    expect(config.plugins.entries["pinchy-files"]).toBeUndefined();
    expect(config.plugins.allow).not.toContain("pinchy-context");
    expect(config.plugins.allow).not.toContain("pinchy-files");
    // pinchy-audit is always enabled to capture tool usage at source
    expect(config.plugins.entries["pinchy-audit"].enabled).toBe(true);
    expect(config.plugins.allow).toContain("pinchy-audit");
  });
});

describe("restart-state integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBackend.readConfig.mockResolvedValue({});
    mockedDb.select.mockReturnValue({
      from: vi.fn().mockResolvedValue([]),
    } as never);
    mockedGetSetting.mockResolvedValue(null);
  });

  it("writeOpenClawConfig calls restartState.notifyRestart", async () => {
    const { restartState } = await import("@/server/restart-state");

    await writeOpenClawConfig({
      provider: "anthropic",
      apiKey: "sk-ant-key",
      model: "anthropic/claude-haiku-4-5-20251001",
    });

    expect(restartState.notifyRestart).toHaveBeenCalledOnce();
  });

  it("regenerateOpenClawConfig calls restartState.notifyRestart", async () => {
    const { restartState } = await import("@/server/restart-state");

    await regenerateOpenClawConfig();

    expect(restartState.notifyRestart).toHaveBeenCalledOnce();
  });
});
