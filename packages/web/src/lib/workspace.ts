import { getBackend } from "@/lib/openclaw-backend";

export const ALLOWED_FILES = ["SOUL.md", "AGENTS.md"] as const;
export type WorkspaceFile = (typeof ALLOWED_FILES)[number];

const DEFAULT_OPENCLAW_WORKSPACE_PREFIX = "/root/.openclaw/workspaces";

const PLACEHOLDER_CONTENT: Record<WorkspaceFile, string> = {
  "SOUL.md": `<!-- Describe your agent's personality here. For example:\nYou are a helpful project manager. You are structured, concise,\nand always keep track of deadlines and action items. -->`,
  "AGENTS.md": `<!-- Define your agent's instructions here. For example:\nYou answer questions about our company's HR policies.\nAlways cite the specific document and section number.\nIf unsure, say so rather than guessing. -->`,
};

function assertAllowedFile(filename: string): asserts filename is WorkspaceFile {
  if (!(ALLOWED_FILES as readonly string[]).includes(filename)) {
    throw new Error(`File not allowed: ${filename}`);
  }
}

function assertValidAgentId(agentId: string): void {
  if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentId.includes("..")) {
    throw new Error(`Invalid agentId: ${agentId}`);
  }
}

export function getOpenClawWorkspacePath(agentId: string): string {
  assertValidAgentId(agentId);
  const prefix = process.env.OPENCLAW_WORKSPACE_PREFIX || DEFAULT_OPENCLAW_WORKSPACE_PREFIX;
  return `${prefix}/${agentId}`;
}

export async function ensureWorkspace(agentId: string): Promise<void> {
  assertValidAgentId(agentId);
  const backend = getBackend();
  await backend.ensureAgentWorkspace(agentId);

  for (const file of ALLOWED_FILES) {
    const existing = await backend.readAgentFile(agentId, file);
    if (!existing) {
      await backend.writeAgentFile(agentId, file, PLACEHOLDER_CONTENT[file]);
    }
  }
}

export async function deleteWorkspace(agentId: string): Promise<void> {
  assertValidAgentId(agentId);
  await getBackend().deleteAgentWorkspace(agentId);
}

export async function readWorkspaceFile(agentId: string, filename: string): Promise<string> {
  assertValidAgentId(agentId);
  assertAllowedFile(filename);
  return getBackend().readAgentFile(agentId, filename);
}

export async function writeWorkspaceFile(
  agentId: string,
  filename: string,
  content: string
): Promise<void> {
  assertValidAgentId(agentId);
  assertAllowedFile(filename);
  await getBackend().writeAgentFile(agentId, filename, content);
}

export async function writeWorkspaceFileInternal(
  agentId: string,
  filename: string,
  content: string
): Promise<void> {
  assertValidAgentId(agentId);
  await getBackend().writeAgentFile(agentId, filename, content);
}

export function generateIdentityContent(agent: { name: string; tagline: string | null }): string {
  const lines = [`# ${agent.name}`];
  if (agent.tagline) lines.push(`> ${agent.tagline}`);
  return lines.join("\n");
}

export async function writeIdentityFile(
  agentId: string,
  agent: { name: string; tagline: string | null }
): Promise<void> {
  assertValidAgentId(agentId);
  await getBackend().writeAgentFile(agentId, "IDENTITY.md", generateIdentityContent(agent));
}
