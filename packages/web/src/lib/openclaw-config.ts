import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { db } from "@/db";
import { agents, mcpServers } from "@/db/schema";
import { getSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import { getOpenClawWorkspacePath } from "@/lib/workspace";
import { restartState } from "@/server/restart-state";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";
import { getServerSlug, buildMcporterServerConfig, decryptEnvVars } from "@/lib/mcp-servers";
import type { McpToolManifestEntry } from "@/db/schema";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

interface OpenClawConfigParams {
  provider: ProviderName;
  apiKey: string;
  model: string;
}

function readExistingConfig(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        source[key] as Record<string, unknown>
      );
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

export function writeOpenClawConfig({ provider, apiKey, model }: OpenClawConfigParams) {
  const existing = readExistingConfig();

  // Generate auth token if none exists in the existing config
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const existingAuth = (existingGateway.auth as Record<string, unknown>) || {};
  const token = (existingAuth.token as string) || randomBytes(24).toString("hex");

  const pinchyFields = {
    gateway: {
      mode: "local",
      bind: "lan",
      auth: { mode: "token", token },
    },
    env: {
      [PROVIDERS[provider].envVar]: apiKey,
    },
    agents: {
      defaults: {
        model: { primary: model },
      },
    },
  };

  const merged = deepMerge(existing, pinchyFields);

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { encoding: "utf-8", mode: 0o644 });
  restartState.notifyRestart();
}

export async function regenerateOpenClawConfig() {
  // Migrate existing Smithers agents first, so their updated allowedTools
  // are reflected in the config we're about to generate.
  await migrateExistingSmithers();

  const existing = readExistingConfig();

  // Preserve only the gateway block from existing config (contains auth token,
  // mode, bind, and any OpenClaw-generated fields). Everything else is rebuilt
  // from DB state so deleted providers/agents get cleaned up.
  const gateway = (existing.gateway as Record<string, unknown>) || { mode: "local", bind: "lan" };
  // Ensure mode and bind are always set
  gateway.mode = "local";
  gateway.bind = "lan";

  // Read all agents from DB
  const allAgents = await db.select().from(agents);

  // Read provider API keys from settings
  const env: Record<string, string> = {};
  for (const [, providerConfig] of Object.entries(PROVIDERS)) {
    const apiKey = await getSetting(providerConfig.settingsKey);
    if (apiKey) {
      env[providerConfig.envVar] = apiKey;
    }
  }

  // Read default provider to set defaults.model
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;
  const defaults: Record<string, unknown> = {};
  if (defaultProvider && PROVIDERS[defaultProvider]) {
    defaults.model = { primary: PROVIDERS[defaultProvider].defaultModel };
  }

  // Build agents list with OpenClaw-side workspace paths, tools.deny, and plugin configs
  const pluginConfigs: Record<string, Record<string, Record<string, unknown>>> = {};
  let contextPluginAgents: Record<string, { tools: string[]; userId: string }> | undefined;

  const agentsList = allAgents.map((agent) => {
    const agentEntry: Record<string, unknown> = {
      id: agent.id,
      name: agent.name,
      model: agent.model,
      workspace: getOpenClawWorkspacePath(agent.id),
    };

    // Compute denied tool groups from allowed tools
    const allowedTools = (agent.allowedTools as string[]) || [];
    const deniedGroups = computeDeniedGroups(allowedTools);
    if (deniedGroups.length > 0) {
      agentEntry.tools = { deny: deniedGroups };
    }

    // Collect plugin config for agents that have file tools (pinchy_ls, pinchy_read)
    const hasFileTools = allowedTools.some((t: string) => t === "pinchy_ls" || t === "pinchy_read");
    if (hasFileTools && agent.pluginConfig) {
      if (!pluginConfigs["pinchy-files"]) {
        pluginConfigs["pinchy-files"] = {};
      }
      pluginConfigs["pinchy-files"][agent.id] = agent.pluginConfig as Record<string, unknown>;
    }

    // Collect plugin config for agents that have context tools (pinchy_save_*)
    const contextTools = allowedTools.filter((t: string) => t.startsWith("pinchy_save_"));
    if (contextTools.length > 0 && agent.ownerId) {
      if (!contextPluginAgents) {
        contextPluginAgents = {};
      }
      contextPluginAgents[agent.id] = {
        tools: contextTools.map((t: string) => t.replace("pinchy_", "")),
        userId: agent.ownerId,
      };
    }

    return agentEntry;
  });

  // Build complete config — gateway preserved, everything else from DB
  const config: Record<string, unknown> = {
    gateway,
    env,
    agents: {
      defaults,
      list: agentsList,
    },
  };

  const entries: Record<string, unknown> = {};
  for (const [pluginId, agentConfigs] of Object.entries(pluginConfigs)) {
    entries[pluginId] = {
      enabled: true,
      config: {
        agents: agentConfigs,
      },
    };
  }

  const gatewayAuth = (gateway as Record<string, unknown>).auth as
    | Record<string, unknown>
    | undefined;
  const gatewayToken = (gatewayAuth?.token as string) || "";

  // Only include pinchy-context when agents use it. Including disabled plugins
  // with config causes OpenClaw to spam "disabled in config but config is present".
  if (contextPluginAgents) {
    entries["pinchy-context"] = {
      enabled: true,
      config: {
        apiBaseUrl: process.env.PINCHY_INTERNAL_URL || "http://pinchy:7777",
        gatewayToken,
        agents: contextPluginAgents,
      },
    };
  }

  // Always include pinchy-audit and keep it enabled. It logs tool usage from
  // OpenClaw hooks so built-in and custom tools are captured at source.
  entries["pinchy-audit"] = {
    enabled: true,
    config: {
      apiBaseUrl: process.env.PINCHY_INTERNAL_URL || "http://pinchy:7777",
      gatewayToken,
    },
  };

  // Note: pinchy-files is only included when agents use it (via pluginConfigs loop above).

  // ── MCP servers: build pinchy-mcp plugin config + mcporter.json ──────
  const allMcpServers = await db.select().from(mcpServers);
  const serversWithTools = allMcpServers.filter(
    (s) => s.toolManifest && (s.toolManifest as McpToolManifestEntry[]).length > 0
  );

  // Collect per-agent MCP tool grants
  const mcpAgentConfig: Record<
    string,
    { allowedMcpTools: Array<{ serverId: string; serverSlug: string; toolName: string }> }
  > = {};
  const referencedServerIds = new Set<string>();

  for (const agent of allAgents) {
    const allowedTools = (agent.allowedTools as string[]) || [];
    const mcpTools = allowedTools.filter((t: string) => t.startsWith("mcp:"));

    if (mcpTools.length === 0) continue;

    const agentMcpTools: Array<{ serverId: string; serverSlug: string; toolName: string }> = [];

    for (const toolId of mcpTools) {
      // Format: mcp:<serverId>:<toolName>
      const parts = toolId.split(":");
      if (parts.length < 3) continue;
      const serverId = parts[1];
      const toolName = parts.slice(2).join(":");

      const server = serversWithTools.find((s) => s.id === serverId);
      if (!server) continue;

      referencedServerIds.add(serverId);
      agentMcpTools.push({
        serverId,
        serverSlug: getServerSlug(server.name),
        toolName,
      });
    }

    if (agentMcpTools.length > 0) {
      mcpAgentConfig[agent.id] = { allowedMcpTools: agentMcpTools };
    }
  }

  // Only include pinchy-mcp when at least one agent has MCP tools
  if (Object.keys(mcpAgentConfig).length > 0) {
    // Write mcporter.json with only referenced servers
    const mcporterServers: Record<string, unknown> = {};
    for (const server of serversWithTools) {
      if (!referencedServerIds.has(server.id)) continue;
      const slug = getServerSlug(server.name);
      const env = decryptEnvVars(server.envVars);
      mcporterServers[slug] = buildMcporterServerConfig(server, env);
    }

    const mcporterConfig = { mcpServers: mcporterServers };
    const configDir = dirname(CONFIG_PATH);
    const mcporterPath = join(configDir, "mcporter.json");

    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }
    writeFileSync(mcporterPath, JSON.stringify(mcporterConfig, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });

    entries["pinchy-mcp"] = {
      enabled: true,
      config: {
        mcporterConfigPath: join("/root/.openclaw", "mcporter.json"),
        agents: mcpAgentConfig,
      },
    };
  }

  // Set plugins.allow to only the enabled plugin IDs. This prevents OpenClaw from
  // auto-discovering unused plugins from the extensions directory, which would cause
  // either a restart loop (invalid config) or "disabled but config present" warning spam.
  const allowedPlugins = Object.keys(entries);

  if (Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o644 });
  restartState.notifyRestart();
}
