/**
 * Keychain auth module for Assrt CLI.
 *
 * Reads the Claude Code OAuth token from macOS Keychain so users
 * who already have Claude Code installed get zero-setup auth.
 *
 * Provider selection
 * ------------------
 * When `ASSRT_PROVIDER` is set in the environment (Fazm's acp-bridge sets it
 * to mirror the user's currently-selected model), credential resolution is
 * pinned to that provider with NO silent cross-provider fallback. This stops
 * Assrt from picking up a stale Claude OAuth token from Keychain when the
 * user is actually on Gemini, and vice versa.
 *
 *   ASSRT_PROVIDER=anthropic → Claude Code OAuth (Keychain) only.
 *                              ANTHROPIC_API_KEY env is IGNORED so Fazm's
 *                              "no API key in subprocess" policy holds.
 *   ASSRT_PROVIDER=gemini    → GEMINI_API_KEY env only. Hard fail if missing.
 *   ASSRT_PROVIDER=codex     → ChatGPT OAuth (Codex) is not a usable direct
 *                              chat-completions credential, so Assrt logs a
 *                              warning and falls back to Claude Code OAuth.
 *                              Tracked as future work; see core/agent.ts.
 *
 * When ASSRT_PROVIDER is unset (CLI users, non-Fazm callers), the original
 * priority chain runs for back-compat: Claude OAuth → ANTHROPIC_API_KEY →
 * GEMINI_API_KEY.
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
  /**
   * How the token authenticates:
   *   "apiKey"    → sent as the x-api-key header (standard Anthropic / Gemini key).
   *   "oauth"     → Authorization: Bearer + the Claude Code oauth beta header.
   *   "authToken" → Authorization: Bearer with NO beta header. For an
   *                 Anthropic-compatible gateway (litellm, internal proxy) that
   *                 speaks bearer auth the Claude-Code way but is not Anthropic
   *                 OAuth, so the oauth-2025-04-20 beta header must be omitted.
   */
  type: "oauth" | "apiKey" | "authToken";
  /** Which model provider this credential authenticates. The agent loop
   *  branches on this to pick the SDK (Anthropic vs Gemini). */
  provider: "anthropic" | "gemini";
}

type ProviderHint = "anthropic" | "gemini" | "codex" | null;

function readProviderHint(): ProviderHint {
  const raw = process.env.ASSRT_PROVIDER?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "anthropic" || raw === "claude") return "anthropic";
  if (raw === "gemini" || raw === "google") return "gemini";
  if (raw === "codex" || raw === "openai" || raw === "chatgpt") return "codex";
  console.error(`[auth] Unknown ASSRT_PROVIDER='${raw}', ignoring hint and falling back to priority chain`);
  return null;
}

function readClaudeOAuthToken(): string | null {
  if (process.platform !== "darwin") return null;
  try {
    const raw = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    const parsed: ClaudeCredentials = JSON.parse(raw);
    return parsed?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve credentials for the agent.
 *
 * With ASSRT_PROVIDER set: pinned to that provider, no cross-provider fallback.
 * Without ASSRT_PROVIDER: legacy priority chain for back-compat.
 */
export function getCredential(): AuthCredential {
  const hint = readProviderHint();

  // ── Pinned provider mode (Fazm sets ASSRT_PROVIDER) ──
  if (hint === "gemini") {
    const geminiKey = process.env.GEMINI_API_KEY;
    if (geminiKey) {
      console.error("[auth] ASSRT_PROVIDER=gemini → using GEMINI_API_KEY env var (gemini)");
      return { token: geminiKey, type: "apiKey", provider: "gemini" };
    }
    throw new Error(
      "ASSRT_PROVIDER=gemini but GEMINI_API_KEY is not set. " +
      "In Fazm, enable Gemini in Settings or switch the selected model to Claude."
    );
  }

  if (hint === "codex") {
    // ChatGPT OAuth tokens (from ~/.codex/auth.json) authenticate codex-acp's
    // JSON-RPC backend, not OpenAI Chat Completions. Until Assrt's agent loop
    // grows a codex-acp transport, the only working credential is Claude OAuth.
    console.error("[auth] ASSRT_PROVIDER=codex: Codex/ChatGPT not yet supported by Assrt; falling back to Claude OAuth");
    const token = readClaudeOAuthToken();
    if (token) {
      console.error("[auth] Using Claude Code OAuth token from macOS Keychain (anthropic, codex fallback)");
      return { token, type: "oauth", provider: "anthropic" };
    }
    throw new Error(
      "ASSRT_PROVIDER=codex but Codex/ChatGPT is not yet supported by Assrt, " +
      "and no Claude Code OAuth token was found in Keychain to fall back to. " +
      "Sign into Claude Code (`claude` in terminal) or switch Fazm's model to Claude/Gemini."
    );
  }

  if (hint === "anthropic") {
    // Strict OAuth-only: do NOT fall back to ANTHROPIC_API_KEY env, even if
    // one happens to be in the subprocess env, so Fazm's "no API key in
    // subprocess" intent is preserved.
    const token = readClaudeOAuthToken();
    if (token) {
      console.error("[auth] ASSRT_PROVIDER=anthropic → using Claude Code OAuth token from macOS Keychain");
      return { token, type: "oauth", provider: "anthropic" };
    }
    throw new Error(
      "ASSRT_PROVIDER=anthropic but no Claude Code OAuth token was found in Keychain. " +
      "Sign into Claude Code (`claude` in terminal) to store one, " +
      "or switch Fazm's model to Gemini."
    );
  }

  // ── Legacy priority chain (no ASSRT_PROVIDER set: CLI users / non-Fazm) ──

  // 1. Claude Code OAuth from Keychain (macOS, zero-setup default).
  //    Tried before ANTHROPIC_API_KEY so a stale shell env var never
  //    silently overrides a fresh Claude Code login.
  const claudeToken = readClaudeOAuthToken();
  if (claudeToken) {
    console.error("[auth] Using Claude Code OAuth token from macOS Keychain (anthropic)");
    return { token: claudeToken, type: "oauth", provider: "anthropic" };
  }

  // 2. ANTHROPIC_API_KEY env var (Linux/CI, or explicit personal key).
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    console.error("[auth] Using ANTHROPIC_API_KEY env var (anthropic)");
    return { token: anthropicKey, type: "apiKey", provider: "anthropic" };
  }

  // 3. ANTHROPIC_AUTH_TOKEN env var (bearer auth for an Anthropic-compatible
  //    gateway). Sent as Authorization: Bearer with no oauth beta header so a
  //    proxy that authenticates the Claude-Code way still accepts it. Honors
  //    ANTHROPIC_BASE_URL, which the SDK reads from env on its own.
  const anthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (anthropicAuthToken) {
    console.error("[auth] Using ANTHROPIC_AUTH_TOKEN env var (anthropic, bearer)");
    return { token: anthropicAuthToken, type: "authToken", provider: "anthropic" };
  }

  // 4. GEMINI_API_KEY env var (last-resort fallback → Gemini provider).
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    console.error("[auth] Using GEMINI_API_KEY env var (gemini)");
    return { token: geminiKey, type: "apiKey", provider: "gemini" };
  }

  throw new Error(
    "No credentials found. Provide one of:\n" +
    "  - Log in to Claude Code (`claude` in terminal) to store an OAuth token in Keychain (preferred), or\n" +
    "  - Set ANTHROPIC_API_KEY (Anthropic, or a gateway that accepts x-api-key), or\n" +
    "  - Set ANTHROPIC_AUTH_TOKEN (Anthropic-compatible gateway with bearer auth; honors ANTHROPIC_BASE_URL), or\n" +
    "  - Set GEMINI_API_KEY (Gemini fallback)."
  );
}
