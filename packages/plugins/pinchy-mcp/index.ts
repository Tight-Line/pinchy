interface PluginToolContext {
  agentId?: string;
}

interface AgentMcpToolGrant {
  serverId: string;
  serverSlug: string;
  toolName: string;
}

interface AgentMcpConfig {
  allowedMcpTools: AgentMcpToolGrant[];
}

interface PluginConfig {
  mcporterConfigPath: string;
  agents: Record<string, AgentMcpConfig>;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
  ) => void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface McpRuntime {
  listTools: (
    server: string,
    options?: { includeSchema?: boolean }
  ) => Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool: (
    server: string,
    toolName: string,
    options?: { args?: Record<string, unknown>; timeoutMs?: number }
  ) => Promise<unknown>;
  close: (server?: string) => Promise<void>;
}

const plugin = {
  id: "pinchy-mcp",
  name: "Pinchy MCP",
  description: "Bridges MCP server tools into OpenClaw agents via mcporter.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "mcporterConfigPath" in value &&
        "agents" in value
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing 'mcporterConfigPath' or 'agents' key in config"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config?.mcporterConfigPath || !config?.agents) {
      console.warn("[pinchy-mcp] No config provided, skipping registration");
      return;
    }

    // Collect all unique tool registrations needed across all agents
    const toolRegistrations = new Map<
      string,
      { serverSlug: string; toolName: string; agentIds: Set<string> }
    >();

    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      for (const grant of agentConfig.allowedMcpTools) {
        const toolKey = `mcp_${grant.serverSlug}_${grant.toolName}`;
        const existing = toolRegistrations.get(toolKey);
        if (existing) {
          existing.agentIds.add(agentId);
        } else {
          toolRegistrations.set(toolKey, {
            serverSlug: grant.serverSlug,
            toolName: grant.toolName,
            agentIds: new Set([agentId]),
          });
        }
      }
    }

    // Lazy-initialize mcporter runtime on first tool call
    let runtimePromise: Promise<McpRuntime> | null = null;

    function getRuntime(): Promise<McpRuntime> {
      if (!runtimePromise) {
        runtimePromise = import("mcporter").then((m) =>
          m.createRuntime({ configPath: config!.mcporterConfigPath })
        );
        runtimePromise.catch((err) => {
          console.error("[pinchy-mcp] Failed to create mcporter runtime:", err);
          runtimePromise = null; // Allow retry on next call
        });
      }
      return runtimePromise;
    }

    // Register each unique tool with a factory that scopes by agent
    for (const [toolKey, registration] of toolRegistrations) {
      api.registerTool(
        (ctx: PluginToolContext) => {
          const agentId = ctx.agentId;
          if (!agentId) return null;
          if (!registration.agentIds.has(agentId)) return null;

          return {
            name: toolKey,
            label: `${registration.serverSlug}: ${registration.toolName}`,
            description: `MCP tool: ${registration.toolName} from ${registration.serverSlug}`,
            parameters: {
              type: "object",
              properties: {
                args: {
                  type: "object",
                  description: "Arguments to pass to the MCP tool",
                  additionalProperties: true,
                },
              },
            },
            async execute(
              _toolCallId: string,
              params: Record<string, unknown>
            ) {
              try {
                const runtime = await getRuntime();
                const args = (params.args as Record<string, unknown>) ?? {};
                const result = await runtime.callTool(
                  registration.serverSlug,
                  registration.toolName,
                  { args, timeoutMs: 30000 }
                );

                // Convert result to text
                const text =
                  typeof result === "string"
                    ? result
                    : JSON.stringify(result, null, 2);

                return { content: [{ type: "text", text }] };
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : "MCP tool call failed";
                console.error(
                  `[pinchy-mcp] Tool ${toolKey} error:`,
                  message
                );
                return {
                  content: [
                    { type: "text", text: `Error calling MCP tool: ${message}` },
                  ],
                };
              }
            },
          };
        },
        { name: toolKey }
      );
    }
  },
};

export default plugin;
