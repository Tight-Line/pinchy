/**
 * Backend abstraction for OpenClaw config and workspace operations.
 *
 * Two implementations:
 * - FilesystemBackend: reads/writes directly to the shared filesystem (default,
 *   current behavior). Requires Pinchy and OpenClaw to share a volume.
 * - ApiBackend: reads/writes via the OpenClaw Gateway RPC API. No shared
 *   filesystem needed; Pinchy and OpenClaw can run in separate pods.
 *
 * Selected via OPENCLAW_BACKEND env var: "filesystem" (default) or "api".
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import type { OpenClawClient } from "openclaw-node";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface OpenClawBackend {
  /** Read the current openclaw.json config object. */
  readConfig(): Promise<Record<string, unknown>>;

  /**
   * Write a complete openclaw.json config. The implementation is responsible
   * for merging or replacing as appropriate.
   */
  writeConfig(config: Record<string, unknown>): Promise<void>;

  /** Signal that the config changed and OpenClaw should restart. */
  notifyConfigChanged(): Promise<void>;

  /** Ensure a workspace directory exists for the given agent. */
  ensureAgentWorkspace(agentId: string): Promise<void>;

  /** Write a file into an agent's workspace. */
  writeAgentFile(agentId: string, filename: string, content: string): Promise<void>;

  /** Read a file from an agent's workspace. Returns "" if missing. */
  readAgentFile(agentId: string, filename: string): Promise<string>;

  /** Delete an agent's workspace directory. */
  deleteAgentWorkspace(agentId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Filesystem Backend (existing behavior)
// ---------------------------------------------------------------------------

export class FilesystemBackend implements OpenClawBackend {
  constructor(
    private configPath: string,
    private workspaceBasePath: string
  ) {}

  async readConfig(): Promise<Record<string, unknown>> {
    try {
      return JSON.parse(readFileSync(this.configPath, "utf-8"));
    } catch {
      return {};
    }
  }

  async writeConfig(config: Record<string, unknown>): Promise<void> {
    const dir = dirname(this.configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), {
      encoding: "utf-8",
      mode: 0o644,
    });
  }

  async notifyConfigChanged(): Promise<void> {
    // Filesystem backend: OpenClaw watches the file for changes.
    // Nothing to do here; the write itself triggers the watcher.
  }

  async ensureAgentWorkspace(agentId: string): Promise<void> {
    const workspacePath = join(this.workspaceBasePath, agentId);
    mkdirSync(workspacePath, { recursive: true });
  }

  async writeAgentFile(agentId: string, filename: string, content: string): Promise<void> {
    const workspacePath = join(this.workspaceBasePath, agentId);
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }
    writeFileSync(join(workspacePath, filename), content, "utf-8");
  }

  async readAgentFile(agentId: string, filename: string): Promise<string> {
    try {
      return readFileSync(join(this.workspaceBasePath, agentId, filename), "utf-8");
    } catch {
      return "";
    }
  }

  async deleteAgentWorkspace(agentId: string): Promise<void> {
    try {
      rmSync(join(this.workspaceBasePath, agentId), {
        recursive: true,
        force: true,
      });
    } catch {
      // Workspace may not exist
    }
  }
}

// ---------------------------------------------------------------------------
// API Backend (uses OpenClaw Gateway RPC)
// ---------------------------------------------------------------------------

export class ApiBackend implements OpenClawBackend {
  private client: OpenClawClient | null = null;
  private configHash: string | null = null;

  setClient(client: OpenClawClient): void {
    this.client = client;
  }

  private requireClient(): OpenClawClient {
    if (!this.client || !this.client.isConnected) {
      throw new Error(
        "OpenClaw API backend requires a connected client. " +
          "Is OpenClaw running and OPENCLAW_WS_URL configured?"
      );
    }
    return this.client;
  }

  async readConfig(): Promise<Record<string, unknown>> {
    const client = this.requireClient();
    const res = await client.request("config.get", {});
    if (!res.ok) {
      throw new Error(`config.get failed: ${res.error?.message}`);
    }
    const payload = res.payload as {
      config?: Record<string, unknown>;
      hash?: string;
    };
    this.configHash = payload.hash ?? null;
    return payload.config ?? {};
  }

  async writeConfig(config: Record<string, unknown>): Promise<void> {
    const client = this.requireClient();

    // If we don't have a hash, get one first for optimistic locking
    if (!this.configHash) {
      await this.readConfig();
    }

    // config.set is fire-and-forget: OpenClaw writes the config file,
    // its file watcher detects the change, and it restarts. The restart
    // kills the WebSocket before the response arrives. We send the
    // request, then wait for the client to reconnect (which means
    // OpenClaw is back up with the new config applied).
    client
      .request("config.set", {
        raw: JSON.stringify(config, null, 2),
        baseHash: this.configHash,
      })
      .catch(() => {
        // Expected: request times out because the restart killed the connection.
      });

    this.configHash = null;
    await this.waitForReconnect(client);
  }

  /**
   * Wait for the client to disconnect and reconnect. Used after config.set
   * to ensure OpenClaw has restarted with the new config before proceeding.
   */
  private waitForReconnect(client: OpenClawClient, timeoutMs = 30_000): Promise<void> {
    return new Promise((resolve, reject) => {
      // If already disconnected, wait for connected event directly.
      // If still connected, wait for disconnect first, then connected.
      const timer = setTimeout(() => {
        client.off("connected", onConnected);
        client.off("disconnected", onDisconnected);
        // If we're still connected, config.set may not have triggered
        // a restart (e.g. no actual config change). That's OK.
        if (client.isConnected) {
          resolve();
        } else {
          reject(new Error("Timed out waiting for OpenClaw to restart after config.set"));
        }
      }, timeoutMs);

      const onConnected = () => {
        clearTimeout(timer);
        client.off("connected", onConnected);
        client.off("disconnected", onDisconnected);
        resolve();
      };

      const onDisconnected = () => {
        // Now wait for reconnect
        client.off("disconnected", onDisconnected);
        client.on("connected", onConnected);
      };

      if (client.isConnected) {
        client.on("disconnected", onDisconnected);
      } else {
        client.on("connected", onConnected);
      }
    });
  }

  async notifyConfigChanged(): Promise<void> {
    // API backend: writeConfig already waits for the restart cycle.
    // Nothing additional needed.
  }

  async ensureAgentWorkspace(agentId: string): Promise<void> {
    // The API backend doesn't need to create directories. OpenClaw's
    // agents.files.set creates the workspace dir on first write.
  }

  async writeAgentFile(agentId: string, filename: string, content: string): Promise<void> {
    const client = this.requireClient();
    const res = await client.request("agents.files.set", {
      agentId,
      name: filename,
      content,
    });
    if (!res.ok) {
      throw new Error(`agents.files.set(${agentId}/${filename}) failed: ${res.error?.message}`);
    }
  }

  async readAgentFile(agentId: string, filename: string): Promise<string> {
    const client = this.requireClient();
    const res = await client.request("agents.files.get", {
      agentId,
      name: filename,
    });
    if (!res.ok) {
      return "";
    }
    const payload = res.payload as {
      file?: { missing?: boolean; content?: string };
    };
    if (payload.file?.missing) {
      return "";
    }
    return payload.file?.content ?? "";
  }

  async deleteAgentWorkspace(agentId: string): Promise<void> {
    const client = this.requireClient();
    // OpenClaw's agents.delete with deleteFiles=true removes the workspace.
    // But we may not want to delete the agent from OpenClaw's config here
    // (Pinchy manages the agent list via config). Instead, clear the files.
    try {
      const listRes = await client.request("agents.files.list", { agentId });
      if (listRes.ok) {
        const payload = listRes.payload as {
          files?: Array<{ name: string; missing?: boolean }>;
        };
        for (const file of payload.files ?? []) {
          if (!file.missing) {
            await client.request("agents.files.set", {
              agentId,
              name: file.name,
              content: "",
            });
          }
        }
      }
    } catch {
      // Best-effort cleanup
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

const BACKEND_KEY = Symbol.for("pinchy.openclawBackend");
const g = globalThis as unknown as Record<symbol, OpenClawBackend>;

/**
 * Get the OpenClaw backend singleton. Created on first call based on
 * the OPENCLAW_BACKEND env var ("filesystem" or "api").
 */
export function getBackend(): OpenClawBackend {
  if (!g[BACKEND_KEY]) {
    const mode = process.env.OPENCLAW_BACKEND || "filesystem";
    if (mode === "api") {
      g[BACKEND_KEY] = new ApiBackend();
    } else {
      const configPath = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";
      const workspaceBasePath = process.env.WORKSPACE_BASE_PATH || "/openclaw-config/workspaces";
      g[BACKEND_KEY] = new FilesystemBackend(configPath, workspaceBasePath);
    }
  }
  return g[BACKEND_KEY];
}

/**
 * Set the OpenClaw client on the API backend. Called from server.ts after
 * the client connects. No-op if using the filesystem backend.
 */
export function setBackendClient(client: OpenClawClient): void {
  const backend = getBackend();
  if (backend instanceof ApiBackend) {
    backend.setClient(client);
  }
}
