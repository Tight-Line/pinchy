import { readFileSync } from "fs";
import { getSetting } from "@/lib/settings";

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || "/openclaw-config/openclaw.json";

function readGatewayTokenFromFile(): string | null {
  try {
    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return config?.gateway?.auth?.token ?? null;
  } catch {
    return null;
  }
}

export async function validateGatewayToken(headers: Headers): Promise<boolean> {
  const authHeader = headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.slice(7);

  // Prefer DB-stored token (works in both filesystem and API mode),
  // fall back to reading from config file (filesystem mode only).
  const gatewayToken = (await getSetting("gateway_token")) || readGatewayTokenFromFile();
  if (!gatewayToken) return false;

  return token === gatewayToken;
}
