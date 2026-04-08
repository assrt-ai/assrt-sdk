/**
 * Keychain auth module for Assrt CLI.
 *
 * Reads the Claude Code OAuth token from macOS Keychain so users
 * who already have Claude Code installed get zero-setup auth.
 */

import { execSync } from "child_process";

const KEYCHAIN_SERVICE = "Claude Code-credentials";

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    scopes: string[];
  };
}

export interface AuthCredential {
  /** The OAuth access token or API key. */
  token: string;
  type: "oauth" | "apiKey";
}

/**
 * Get the Claude Code OAuth token from macOS Keychain.
 * Users must have Claude Code installed and logged in.
 */
export function getCredential(): AuthCredential {
  if (process.platform !== "darwin") {
    throw new Error(
      "Assrt CLI currently requires macOS with Claude Code installed.\n" +
      "Log in to Claude Code (`claude` in terminal) to store credentials in Keychain."
    );
  }

  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const parsed: ClaudeCredentials = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    if (token) {
      console.error("[auth] Using Claude Code OAuth token from macOS Keychain");
      return { token, type: "oauth" };
    }
  } catch {
    // Keychain entry not found or parse failed
  }

  // Fall back to ANTHROPIC_API_KEY env var
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    console.error("[auth] Using ANTHROPIC_API_KEY env var");
    return { token: apiKey, type: "apiKey" };
  }

  throw new Error(
    "No credentials found. Either:\n" +
    "  - Log in to Claude Code (`claude` in terminal) to store credentials in Keychain, or\n" +
    "  - Set the ANTHROPIC_API_KEY environment variable."
  );
}
