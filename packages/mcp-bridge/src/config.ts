import { homedir } from "node:os";
import { join } from "node:path";

// Bridge configuration: everything comes from the environment, and no
// secret ever does — the only credential the bridge holds is the refresh
// token in the token store, written by the OAuth flow itself.

/** The production gateway the console talks to (apps/console DocsPage + vercel.json rewrites). */
export const DEFAULT_BASE_URL = "https://api.aiverse.network";

/**
 * The full scope set the consent screen can grant — mirrors OAUTH_SCOPES
 * in apps/gateway/src/auth/oauthCore.ts. The gateway rejects anything
 * outside its vocabulary, so this list must track it exactly.
 */
export const DEFAULT_SCOPES = [
  "world:observe",
  "world:act",
  "inbox:read",
  "relay:send",
  "discover",
] as const;

export interface BridgeConfig {
  /** Gateway origin, no trailing slash. */
  baseUrl: string;
  /** Scopes requested at authorize time (AIVERSE_SCOPES overrides). */
  scopes: string[];
  /** Per-user config dir holding the token store. */
  configDir: string;
  /** The refresh-token store file (mode 0600, enforced by TokenStore). */
  tokenFile: string;
}

export function resolveConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  const baseUrl = (env.AIVERSE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const scopes = env.AIVERSE_SCOPES
    ? env.AIVERSE_SCOPES.split(/\s+/).filter(Boolean)
    : [...DEFAULT_SCOPES];
  const configHome =
    env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  const configDir = join(configHome, "aiverse-bridge");
  return { baseUrl, scopes, configDir, tokenFile: join(configDir, "tokens.json") };
}
