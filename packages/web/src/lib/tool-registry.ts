export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful" | "mcp";
  group?: string;
  requiresDirectories?: boolean;
  serverName?: string;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  // Safe tools — sandboxed, admin-configured paths
  {
    id: "pinchy_ls",
    label: "List approved directories",
    description: "List files in directories the admin has approved",
    category: "safe",
    requiresDirectories: true,
  },
  {
    id: "pinchy_read",
    label: "Read approved files",
    description: "Read file contents from approved directories only",
    category: "safe",
    requiresDirectories: true,
  },

  // Powerful tools — direct server access
  {
    id: "shell",
    label: "Run commands",
    description: "Execute shell commands on the server",
    category: "powerful",
    group: "group:runtime",
  },
  {
    id: "fs_read",
    label: "Read any file",
    description: "Read any file on the system, without restrictions",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "fs_write",
    label: "Write files",
    description: "Create and modify files on the system",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "web_fetch",
    label: "Browse the web",
    description: "Fetch web pages",
    category: "powerful",
    group: "group:web",
  },
  {
    id: "web_search",
    label: "Search the web",
    description: "Perform web searches",
    category: "powerful",
    group: "group:web",
  },
];

const ALL_GROUPS = ["group:runtime", "group:fs", "group:web"] as const;

export function getToolById(id: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

export function getToolsByCategory(category: "safe" | "powerful"): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.category === category);
}

export async function getAllToolDefinitions(): Promise<ToolDefinition[]> {
  const { getMcpToolDefinitions } = await import("@/lib/mcp-servers");
  const mcpTools = await getMcpToolDefinitions();
  return [...TOOL_REGISTRY, ...mcpTools];
}

/**
 * Given a list of allowed tool IDs, compute which OpenClaw tool groups to deny.
 * Any group that has at least one allowed tool is NOT denied.
 * Safe tools (pinchy_*) are ignored — they're managed via the plugin system.
 */
export function computeDeniedGroups(allowedToolIds: string[]): string[] {
  const allowedGroups = new Set<string>();

  for (const toolId of allowedToolIds) {
    const tool = getToolById(toolId);
    if (tool?.group) {
      allowedGroups.add(tool.group);
    }
  }

  return ALL_GROUPS.filter((g) => !allowedGroups.has(g));
}
