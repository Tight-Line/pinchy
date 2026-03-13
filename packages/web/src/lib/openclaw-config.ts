import { randomBytes } from "crypto";
import { PROVIDERS, type ProviderName } from "@/lib/providers";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { getSetting, setSetting } from "@/lib/settings";
import { computeDeniedGroups } from "@/lib/tool-registry";
import { getOpenClawWorkspacePath } from "@/lib/workspace";
import { restartState } from "@/server/restart-state";
import { migrateExistingSmithers } from "@/lib/migrate-onboarding";
import { getBackend } from "@/lib/openclaw-backend";

interface OpenClawConfigParams {
  provider: ProviderName;
  apiKey: string;
  model: string;
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

export async function writeOpenClawConfig({ provider, apiKey, model }: OpenClawConfigParams) {
  const backend = getBackend();
  const existing = await backend.readConfig();

  // Generate auth token if none exists. Prefer DB-stored token (reliable
  // across backends), fall back to reading from config (filesystem mode).
  const existingGateway = (existing.gateway as Record<string, unknown>) || {};
  const existingAuth = (existingGateway.auth as Record<string, unknown>) || {};
  const storedToken = await getSetting("gateway_token");
  const token = storedToken || (existingAuth.token as string) || randomBytes(24).toString("hex");
  await setSetting("gateway_token", token, true);

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

  restartState.notifyRestart();
  await backend.writeConfig(merged);
  await backend.notifyConfigChanged();
}

export async function regenerateOpenClawConfig() {
  // Migrate existing Smithers agents first, so their updated allowedTools
  // are reflected in the config we're about to generate. The migration
  // only updates DB rows (allowedTools); workspace file writes happen
  // after the config is pushed so OpenClaw knows about all agents.
  await migrateExistingSmithers({ skipFileWrites: true });

  const backend = getBackend();
  const existing = await backend.readConfig();

  // Preserve the gateway block from existing config. In API mode, the
  // auth token comes back as a redacted sentinel; OpenClaw will un-redact
  // it when we send the config back via config.set.
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

  // Read the gateway token from DB settings (where writeOpenClawConfig
  // persists it). This avoids relying on config.get which redacts secrets
  // in API mode.
  const gatewayToken = (await getSetting("gateway_token")) || "";

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

  // Set plugins.allow to only the enabled plugin IDs. This prevents OpenClaw from
  // auto-discovering unused plugins from the extensions directory, which would cause
  // either a restart loop (invalid config) or "disabled but config present" warning spam.
  const allowedPlugins = Object.keys(entries);

  if (Object.keys(entries).length > 0) {
    config.plugins = { allow: allowedPlugins, entries };
  }

  // Notify before writeConfig so the restart state is set when the
  // reconnect handler fires (in API mode, writeConfig blocks until
  // reconnection).
  restartState.notifyRestart();

  await backend.writeConfig(config);
  await backend.notifyConfigChanged();

  // Now that the config is pushed (and OpenClaw knows about all agents),
  // write any workspace files that the migration deferred.
  await migrateExistingSmithers({ skipDbUpdates: true });
}
