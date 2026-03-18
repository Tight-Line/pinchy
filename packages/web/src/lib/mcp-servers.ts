import { writeFileSync, unlinkSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { mcpServers, agents, type McpToolManifestEntry } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import type { ToolDefinition } from "@/lib/tool-registry";

// ── Types ────────────────────────────────────────────────────────────────

export interface CreateMcpServerInput {
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  envVars?: Record<string, string>;
}

export interface UpdateMcpServerInput {
  name?: string;
  transport?: "stdio" | "http";
  command?: string | null;
  args?: string[];
  url?: string | null;
  envVars?: Record<string, string> | null;
}

export interface McpServer {
  id: string;
  name: string;
  transport: string;
  command: string | null;
  args: string[];
  url: string | null;
  status: string;
  statusMessage: string | null;
  lastCheckedAt: Date | null;
  toolManifest: McpToolManifestEntry[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpServerWithEnvKeys extends McpServer {
  envVarKeys: string[];
}

interface DiscoverResult {
  success: boolean;
  tools?: McpToolManifestEntry[];
  error?: string;
}

// ── Slug generation ──────────────────────────────────────────────────────

export function getServerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 30);
}

// ── Shell injection validation ───────────────────────────────────────────

const SHELL_METACHARACTERS = /[;|&`$(){}]/;

export function validateCommand(command: string): string | null {
  if (SHELL_METACHARACTERS.test(command)) {
    return "Command contains prohibited shell metacharacters";
  }
  return null;
}

// ── CRUD ─────────────────────────────────────────────────────────────────

export async function createMcpServer(input: CreateMcpServerInput): Promise<McpServer> {
  const encryptedEnvVars =
    input.envVars && Object.keys(input.envVars).length > 0
      ? encrypt(JSON.stringify(input.envVars))
      : null;

  const [server] = await db
    .insert(mcpServers)
    .values({
      name: input.name,
      transport: input.transport,
      command: input.command ?? null,
      args: input.args ?? [],
      url: input.url ?? null,
      envVars: encryptedEnvVars,
    })
    .returning();

  return toMcpServer(server);
}

export async function updateMcpServer(
  id: string,
  input: UpdateMcpServerInput
): Promise<McpServer | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };

  if (input.name !== undefined) updates.name = input.name;
  if (input.transport !== undefined) updates.transport = input.transport;
  if (input.command !== undefined) updates.command = input.command;
  if (input.args !== undefined) updates.args = input.args;
  if (input.url !== undefined) updates.url = input.url;
  if (input.envVars !== undefined) {
    updates.envVars =
      input.envVars && Object.keys(input.envVars).length > 0
        ? encrypt(JSON.stringify(input.envVars))
        : null;
  }

  const [updated] = await db
    .update(mcpServers)
    .set(updates)
    .where(eq(mcpServers.id, id))
    .returning();

  if (!updated) return null;
  return toMcpServer(updated);
}

export async function deleteMcpServer(id: string): Promise<McpServer | null> {
  // Strip mcp:<id>:* from all agents' allowedTools
  const allAgents = await db.select().from(agents);
  const prefix = `mcp:${id}:`;

  for (const agent of allAgents) {
    const tools = (agent.allowedTools as string[]) || [];
    const filtered = tools.filter((t) => !t.startsWith(prefix));
    if (filtered.length !== tools.length) {
      await db.update(agents).set({ allowedTools: filtered }).where(eq(agents.id, agent.id));
    }
  }

  const [deleted] = await db.delete(mcpServers).where(eq(mcpServers.id, id)).returning();

  if (!deleted) return null;
  return toMcpServer(deleted);
}

export async function listMcpServers(): Promise<McpServerWithEnvKeys[]> {
  const servers = await db.select().from(mcpServers);
  return servers.map(toMcpServerWithEnvKeys);
}

export async function getMcpServer(id: string): Promise<McpServerWithEnvKeys | null> {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));

  if (!server) return null;
  return toMcpServerWithEnvKeys(server);
}

// ── Tool discovery via mcporter ──────────────────────────────────────────

export async function discoverTools(serverId: string): Promise<DiscoverResult> {
  const [server] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));

  if (!server) return { success: false, error: "Server not found" };

  let configPath: string | undefined;

  try {
    const { createRuntime } = await import("mcporter");

    // Build temp mcporter config with decrypted env vars
    configPath = writeTempMcporterConfig(server);
    const slug = getServerSlug(server.name);

    const runtime = await createRuntime({ configPath });

    try {
      const tools = await runtime.listTools(slug, { includeSchema: true });
      const manifest: McpToolManifestEntry[] = tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {},
      }));

      await db
        .update(mcpServers)
        .set({
          toolManifest: manifest,
          status: "connected",
          statusMessage: null,
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(mcpServers.id, serverId));

      return { success: true, tools: manifest };
    } finally {
      await runtime.close();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    await db
      .update(mcpServers)
      .set({
        status: "error",
        statusMessage: message,
        lastCheckedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(mcpServers.id, serverId));

    return { success: false, error: message };
  } finally {
    if (configPath) {
      try {
        unlinkSync(configPath);
      } catch {
        // best effort cleanup
      }
    }
  }
}

export async function testConnection(serverId: string): Promise<DiscoverResult> {
  return discoverTools(serverId);
}

// ── MCP tool definitions for the tool registry ───────────────────────────

export async function getMcpToolDefinitions(): Promise<ToolDefinition[]> {
  const servers = await db.select().from(mcpServers);
  const tools: ToolDefinition[] = [];

  for (const server of servers) {
    if (!server.toolManifest) continue;
    const manifest = server.toolManifest as McpToolManifestEntry[];

    for (const tool of manifest) {
      tools.push({
        id: `mcp:${server.id}:${tool.name}`,
        label: tool.name,
        description: tool.description,
        category: "mcp",
        serverName: server.name,
      });
    }
  }

  return tools;
}

// ── mcporter config building ─────────────────────────────────────────────

interface McpServerRow {
  name: string;
  transport: string;
  command: string | null;
  args: string[] | unknown;
  url: string | null;
  envVars: string | null;
}

export function buildMcporterServerConfig(
  server: McpServerRow,
  decryptedEnv?: Record<string, string>
): Record<string, unknown> {
  const env = decryptedEnv ?? decryptEnvVars(server.envVars);

  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: Array.isArray(server.args) ? server.args : [],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  // HTTP transport
  return {
    baseUrl: server.url,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

export function decryptEnvVars(encryptedEnvVars: string | null): Record<string, string> {
  if (!encryptedEnvVars) return {};
  try {
    return JSON.parse(decrypt(encryptedEnvVars));
  } catch {
    return {};
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function writeTempMcporterConfig(server: McpServerRow): string {
  const slug = getServerSlug(server.name);
  const env = decryptEnvVars(server.envVars);
  const serverConfig = buildMcporterServerConfig(server, env);

  const config = {
    mcpServers: {
      [slug]: serverConfig,
    },
  };

  const dir = join(tmpdir(), "pinchy-mcp");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filePath = join(dir, `mcporter-${randomBytes(8).toString("hex")}.json`);
  writeFileSync(filePath, JSON.stringify(config, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });

  return filePath;
}

function toMcpServer(row: typeof mcpServers.$inferSelect): McpServer {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args: (row.args as string[]) ?? [],
    url: row.url,
    status: row.status,
    statusMessage: row.statusMessage,
    lastCheckedAt: row.lastCheckedAt,
    toolManifest: row.toolManifest as McpToolManifestEntry[] | null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toMcpServerWithEnvKeys(row: typeof mcpServers.$inferSelect): McpServerWithEnvKeys {
  const server = toMcpServer(row);
  let envVarKeys: string[] = [];
  if (row.envVars) {
    try {
      const parsed = JSON.parse(decrypt(row.envVars));
      envVarKeys = Object.keys(parsed);
    } catch {
      // corrupted env vars — return empty keys
    }
  }
  return { ...server, envVarKeys };
}
