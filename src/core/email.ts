/**
 * Disposable email service using temp-mail.io internal API.
 *
 * Endpoints:
 *   POST https://api.internal.temp-mail.io/api/v3/email/new → { email, token }
 *   GET  https://api.internal.temp-mail.io/api/v3/email/{email}/messages → [messages]
 */

const BASE = "https://api.internal.temp-mail.io/api/v3";

interface TempMailMessage {
  id: string;
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body_text: string;
  body_html: string;
  created_at: string;
  attachments: unknown[];
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
}

export class DisposableEmail {
  public address: string;
  private token: string;

  private constructor(address: string, token: string) {
    this.address = address;
    this.token = token;
  }

  /** Create a new random disposable email address */
  static async create(): Promise<DisposableEmail> {
    const data = await fetchJson<{ email: string; token: string }>(
      `${BASE}/email/new`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ min_name_length: 10, max_name_length: 10 }),
      }
    );
    if (!data.email || !data.token) {
      throw new Error(`Invalid response: ${JSON.stringify(data)}`);
    }
    return new DisposableEmail(data.email, data.token);
  }

  /** Check inbox for messages */
  async getMessages(): Promise<TempMailMessage[]> {
    return fetchJson<TempMailMessage[]>(`${BASE}/email/${this.address}/messages`);
  }

  /**
   * Wait for a new email to arrive.
   * Polls every `intervalMs` for up to `timeoutMs`.
   */
  async waitForEmail(timeoutMs = 60000, intervalMs = 3000): Promise<TempMailMessage | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const messages = await this.getMessages();
      if (messages.length > 0) {
        return messages[messages.length - 1];
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
  }

  /**
   * Wait for a verification email and extract the code from it.
   */
  async waitForVerificationCode(
    timeoutMs = 60000,
    intervalMs = 3000
  ): Promise<{ code: string; from: string; subject: string; body: string } | null> {
    const email = await this.waitForEmail(timeoutMs, intervalMs);
    if (!email) return null;

    // Get plain text — prefer body_text, fall back to stripping HTML
    let plainText = email.body_text || "";
    if (!plainText && email.body_html) {
      plainText = email.body_html
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&#?\w+;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // Try multiple patterns for verification codes (most specific first)
    const patterns = [
      /(?:code|Code|CODE)[:\s]+(\d{4,8})/,
      /(?:verification|Verification)[:\s]+(\d{4,8})/,
      /(?:OTP|otp)[:\s]+(\d{4,8})/,
      /(?:pin|PIN|Pin)[:\s]+(\d{4,8})/,
      /\b(\d{6})\b/, // 6-digit (most common)
      /\b(\d{4})\b/, // 4-digit
      /\b(\d{8})\b/, // 8-digit
    ];

    for (const pattern of patterns) {
      const match = plainText.match(pattern);
      if (match) {
        return {
          code: match[1],
          from: email.from,
          subject: email.subject,
          body: plainText.slice(0, 500),
        };
      }
    }

    return {
      code: "",
      from: email.from,
      subject: email.subject,
      body: plainText.slice(0, 500),
    };
  }
}
