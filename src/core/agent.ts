import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI, Type } from "@google/genai";
import { McpBrowserManager } from "./browser";
import { DisposableEmail } from "./email";
import type { TestStep, TestAssertion, ScenarioResult, TestReport } from "./types";

const MAX_STEPS_PER_SCENARIO = 60;
const MAX_CONVERSATION_TURNS = Infinity;
const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_GEMINI_MODEL = "gemini-3.1-pro-preview";

type Provider = "anthropic" | "gemini";

/* ── Tool definitions using Playwright MCP concepts ──────── */

const TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Navigate to a URL.",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "snapshot",
    description: "Get the accessibility tree of the current page. Returns elements with [ref=eN] references you can use for click/type. ALWAYS call this before interacting with elements.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "click",
    description: "Click an element. Use the element description from the snapshot and optionally the ref ID.",
    input_schema: {
      type: "object" as const,
      properties: {
        element: { type: "string", description: "Human-readable element description, e.g. 'Submit button' or 'Sign In link'" },
        ref: { type: "string", description: "Exact ref from snapshot, e.g. 'e5'. Preferred when available." },
      },
      required: ["element"],
    },
  },
  {
    name: "type_text",
    description: "Type text into an input field. Clears existing content first.",
    input_schema: {
      type: "object" as const,
      properties: {
        element: { type: "string", description: "Human-readable element description" },
        text: { type: "string", description: "Text to type" },
        ref: { type: "string", description: "Exact ref from snapshot" },
      },
      required: ["element", "text"],
    },
  },
  {
    name: "select_option",
    description: "Select an option from a dropdown.",
    input_schema: {
      type: "object" as const,
      properties: {
        element: { type: "string", description: "Element description" },
        values: { type: "array", items: { type: "string" }, description: "Values to select" },
      },
      required: ["element", "values"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page. Positive y scrolls down, negative scrolls up.",
    input_schema: {
      type: "object" as const,
      properties: {
        x: { type: "number", description: "Horizontal scroll pixels (default: 0)" },
        y: { type: "number", description: "Vertical scroll pixels (default: 400 for down, -400 for up)" },
      },
      required: ["y"],
    },
  },
  {
    name: "press_key",
    description: "Press a keyboard key. E.g. Enter, Tab, Escape.",
    input_schema: {
      type: "object" as const,
      properties: { key: { type: "string", description: "Key to press" } },
      required: ["key"],
    },
  },
  {
    name: "wait",
    description: "Wait for text to appear on the page, or wait a fixed duration.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string", description: "Text to wait for (preferred)" },
        ms: { type: "number", description: "Milliseconds to wait (fallback, max 10000)" },
      },
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current page.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "evaluate",
    description: "Run JavaScript in the browser and return the result.",
    input_schema: {
      type: "object" as const,
      properties: { expression: { type: "string", description: "JavaScript expression to evaluate" } },
      required: ["expression"],
    },
  },
  {
    name: "create_temp_email",
    description: "Create a disposable email address. Use BEFORE filling signup forms.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "wait_for_verification_code",
    description: "Wait for a verification/OTP code at the disposable email. Polls up to 60s.",
    input_schema: {
      type: "object" as const,
      properties: { timeout_seconds: { type: "number", description: "Max seconds to wait (default 60)" } },
    },
  },
  {
    name: "check_email_inbox",
    description: "Check the disposable email inbox.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "assert",
    description: "Make a test assertion about the current page state.",
    input_schema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "What you are asserting" },
        passed: { type: "boolean", description: "Whether the assertion passed" },
        evidence: { type: "string", description: "Evidence for the result" },
      },
      required: ["description", "passed", "evidence"],
    },
  },
  {
    name: "complete_scenario",
    description: "Mark the current test scenario as complete.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string", description: "Summary of what was tested" },
        passed: { type: "boolean", description: "Whether the scenario passed overall" },
      },
      required: ["summary", "passed"],
    },
  },
  {
    name: "suggest_improvement",
    description: "Report an obvious bug or UX issue in the application.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short title" },
        severity: { type: "string", description: "critical, major, or minor" },
        description: { type: "string", description: "What is wrong" },
        suggestion: { type: "string", description: "How to fix it" },
      },
      required: ["title", "severity", "description", "suggestion"],
    },
  },
  {
    name: "http_request",
    description: "Make an HTTP request to an external API. Use for verifying webhooks, polling APIs (Telegram, Slack, GitHub), or any external service interaction.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "Full URL to request" },
        method: { type: "string", description: "HTTP method: GET, POST, PUT, DELETE (default: GET)" },
        headers: { type: "object", description: "Request headers as key-value pairs" },
        body: { type: "string", description: "Request body (JSON string for POST/PUT)" },
      },
      required: ["url"],
    },
  },
  {
    name: "wait_for_stable",
    description: "Wait until the page content stops changing (no new DOM mutations for the specified stable period). Use after triggering async actions like chat AI responses, loading states, or search results populating.",
    input_schema: {
      type: "object" as const,
      properties: {
        timeout_seconds: { type: "number", description: "Max seconds to wait (default 30)" },
        stable_seconds: { type: "number", description: "Seconds of no DOM changes to consider stable (default 2)" },
      },
    },
  },
];

const SYSTEM_PROMPT = `You are an automated web testing agent called Assrt. Your job is to systematically test web applications by executing test scenarios.

## How You Work
1. You receive test scenario(s) to execute on a web application
2. You interact with the page using the provided tools
3. You verify expected behavior using assertions
4. You report results clearly

## CRITICAL Rules
- ALWAYS call snapshot FIRST to get the accessibility tree with element refs
- Use the ref IDs from snapshots (e.g. ref="e5") when clicking or typing. This is faster and more reliable than text matching.
- After each action, call snapshot again to see the updated page state
- Make assertions to verify expected behavior (use the assert tool)
- Call complete_scenario when done

## Selector Strategy (Playwright MCP refs)
1. Call snapshot to get the accessibility tree
2. Find the element you want to interact with in the tree
3. Use its ref value (e.g. "e5") in the ref parameter of click/type_text
4. Also provide a human-readable element description for logging
5. If a ref is stale (action fails), call snapshot again to get fresh refs

## Error Recovery
When an action fails:
1. Call snapshot to see what is currently on the page
2. The page may have changed (modal appeared, navigation happened)
3. Try using a different ref or approach
4. If stuck after 3 attempts, scroll and retry
5. If truly stuck, mark as failed with evidence and call complete_scenario

## Email Verification Strategy
When you encounter a login/signup form that requires an email:
1. FIRST call create_temp_email to get a disposable email
2. Use THAT email in the signup form
3. After submitting, call wait_for_verification_code for the OTP
4. Enter the verification code into the form
   - If the code input is split across multiple single-character fields (common OTP pattern), do NOT type into each field individually. Instead, find the parent container of the input fields in the snapshot (the generic element that wraps all the textboxes), then use evaluate on that container to dispatch a paste event:
     \`(el) => { const dt = new DataTransfer(); dt.setData('text/plain', 'CODE_HERE'); el.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true})); return 'pasted'; }\`
     Pass the container's ref to evaluate so it receives the element. Replace CODE_HERE with the actual code. Then call snapshot to verify all digits filled correctly. This is MUCH faster than typing into 6 fields one at a time.

## Scenario Continuity
- Scenarios run in the SAME browser session
- Cookies, auth state carry over between scenarios
- Take advantage of existing state rather than starting from scratch

## External API Verification
When testing integrations (Telegram, Slack, GitHub, etc.):
1. Use http_request to call external APIs (e.g. poll Telegram Bot API for messages)
2. This lets you verify that actions in the web app produced the expected external effect
3. Example: after connecting Telegram in a web app, use http_request to call https://api.telegram.org/bot<token>/getUpdates to verify messages arrived

## Waiting for Async Content
When the page has loading states, streaming AI responses, or async content:
1. Use wait_for_stable to wait until the DOM stops changing
2. This is better than wait with a fixed time because it adapts to actual load speed
3. Use it after submitting forms, sending chat messages, or triggering any async operation
4. Then call snapshot to see the final state`;

const DISCOVERY_SYSTEM_PROMPT = `You are a QA engineer generating quick test cases for an AI browser agent that just landed on a new page. The agent can click, type, scroll, and verify visible text.

## Output Format
#Case 1: [short name]
[1-2 lines: what to click/type and what to verify]

## Rules
- Generate only 1-2 cases
- Each case must be completable in 3-4 actions max
- Reference ACTUAL buttons/links/inputs visible on the page
- Do NOT generate login/signup cases
- Do NOT generate cases about CSS, responsive layout, or performance`;

const MAX_CONCURRENT_DISCOVERIES = 3;
const MAX_DISCOVERED_PAGES = 20;
const SKIP_URL_PATTERNS = [/\/logout/i, /\/api\//i, /^javascript:/i, /^about:blank/i, /^data:/i, /^chrome/i];

type EmitFn = (type: string, data: unknown) => void;

/* ── Gemini function declarations ── */

const GEMINI_FUNCTION_DECLARATIONS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  parameters: {
    type: Type.OBJECT,
    properties: Object.fromEntries(
      Object.entries((t.input_schema as { properties?: Record<string, unknown> }).properties || {}).map(
        ([k, v]) => {
          const vTyped = v as { type: string; description?: string; items?: { type: string } };
          let gType;
          if (vTyped.type === "boolean") gType = Type.BOOLEAN;
          else if (vTyped.type === "number") gType = Type.NUMBER;
          else if (vTyped.type === "array") gType = Type.ARRAY;
          else gType = Type.STRING;
          const entry: Record<string, unknown> = { type: gType, description: vTyped.description || "" };
          if (vTyped.type === "array" && vTyped.items) {
            entry.items = { type: Type.STRING };
          }
          return [k, entry];
        }
      )
    ),
    required: (t.input_schema as { required?: string[] }).required || [],
  },
}));

export type AgentMode = "local" | "remote";

export class TestAgent {
  private anthropic: Anthropic | null = null;
  private gemini: GoogleGenAI | null = null;
  private browser: McpBrowserManager;
  private emit: EmitFn;
  private tempEmail: DisposableEmail | null = null;
  private discoveredUrls: Set<string> = new Set();
  private activeDiscoveries = 0;
  private model: string;
  private provider: Provider;
  private browserBusy = false;
  private pendingDiscoveryUrls: string[] = [];
  private broadcastFrame: ((jpeg: Buffer) => void) | null = null;
  private mode: AgentMode;

  /**
   * @param broadcastFrame — Optional callback for CDP screencast frames.
   *   When provided, replaces the old 1.5s screenshot polling with continuous
   *   ~15fps streaming. When absent (e.g., plan generation), falls back to
   *   SSE screenshot emits.
   * @param mode — "local" spawns a local Playwright MCP over stdio,
   *   "remote" (default) uses a Freestyle VM.
   */
  /**
   * @param authType — "apiKey" for regular API keys (X-Api-Key header),
   *   "oauth" for Claude Code OAuth tokens (Authorization: Bearer + beta header).
   */
  /** Directory for video recording output. Only used in local mode. */
  private videoDir: string | null = null;

  constructor(apiKey: string, emit: EmitFn, model?: string, provider?: string, broadcastFrame?: ((jpeg: Buffer) => void) | null, mode?: AgentMode, authType?: "apiKey" | "oauth", videoDir?: string) {
    this.provider = (provider === "gemini" ? "gemini" : "anthropic") as Provider;
    this.browser = new McpBrowserManager();
    this.emit = emit;
    this.broadcastFrame = broadcastFrame || null;
    this.mode = mode || "remote";
    this.videoDir = videoDir || null;

    if (this.provider === "gemini") {
      this.gemini = new GoogleGenAI({ apiKey });
      this.model = model || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
    } else {
      if (authType === "oauth") {
        this.anthropic = new Anthropic({
          authToken: apiKey,
          defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
        });
      } else {
        this.anthropic = new Anthropic({ apiKey });
      }
      this.model = model || process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
    }
  }

  async run(url: string, scenariosText: string): Promise<TestReport> {
    const startTime = Date.now();
    console.log(JSON.stringify({ event: "agent.run.start", url, mode: this.mode, model: this.model, ts: new Date().toISOString() }));
    if (this.mode === "local") {
      this.emit("status", { message: "Launching local browser..." });
      await this.browser.launchLocal(this.videoDir || undefined);
    } else {
      this.emit("status", { message: "Provisioning cloud browser VM..." });
      await this.browser.launch();
    }
    const launchMs = Date.now() - startTime;
    console.log(JSON.stringify({ event: "agent.browser.launched", durationMs: launchMs, ts: new Date().toISOString() }));
    this.emit("status", { message: "Browser launched via Playwright MCP" });

    // Send the screencast WebSocket URL so the client can connect directly
    const screencastUrl = this.browser.screencastUrl;
    if (screencastUrl) {
      this.emit("screencast_url", { url: screencastUrl });
    }

    // Send the input WebSocket URL so the client can send mouse/keyboard events
    const inputUrl = this.browser.inputUrl;
    if (inputUrl) {
      this.emit("input_url", { url: inputUrl });
    }

    // Send the VNC WebSocket URL for noVNC takeover
    const vncUrl = this.browser.vncUrl;
    if (vncUrl) {
      this.emit("vnc_url", { url: vncUrl });
    }

    // Send the VM ID so the client can release the VM after takeover
    const vmId = this.browser.vmId;
    if (vmId) {
      this.emit("vm_id", { vmId });
    }

    const tNav = Date.now();
    await this.browser.navigate(url);
    console.log(JSON.stringify({ event: "agent.navigate.done", url, durationMs: Date.now() - tNav, ts: new Date().toISOString() }));
    this.emit("status", { message: `Navigated to ${url}` });

    this.queueDiscoverPage(url);

    const scenarios = this.parseScenarios(scenariosText);
    const results: ScenarioResult[] = [];

    try {
      for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        this.emit("scenario_start", { index: i, name: scenario.name, total: scenarios.length });

        try {
          const result = await this.runScenario(
            url, scenario.name, scenario.steps, i === 0,
            results.map((r) => `${r.name}: ${r.passed ? "PASSED" : "FAILED"} — ${r.summary}`)
          );
          results.push(result);
          this.emit("scenario_complete", { index: i, name: scenario.name, passed: result.passed, summary: result.summary });
          await this.flushDiscovery().catch(() => {});
        } catch (scenarioErr: unknown) {
          const errMsg = scenarioErr instanceof Error ? scenarioErr.message : String(scenarioErr);
          this.emit("reasoning", { text: `Scenario "${scenario.name}" crashed: ${errMsg}. Moving to next scenario.` });
          const failedResult: ScenarioResult = {
            name: scenario.name, passed: false, steps: [], assertions: [],
            summary: `Error: ${errMsg.slice(0, 200)}`, duration: 0,
          };
          results.push(failedResult);
          this.emit("scenario_complete", { index: i, name: scenario.name, passed: false, summary: failedResult.summary });
        }
      }
    } finally {
      // Don't close the browser here — keep the VM alive so the user can
      // take over and interact after the test finishes. The VM will be
      // released explicitly via /api/release-vm or by Freestyle's idle timeout.
    }

    const report: TestReport = {
      url, scenarios: results, totalDuration: Date.now() - startTime,
      passedCount: results.filter((r) => r.passed).length,
      failedCount: results.filter((r) => !r.passed).length,
      generatedAt: new Date().toISOString(),
    };

    this.emit("report", report);
    return report;
  }

  /** Encode and download the screencast recording from the VM.
   *  Does NOT destroy the VM (it stays alive for user takeover). */
  async finalizeVideo(): Promise<Buffer | null> {
    try {
      // Trigger ffmpeg encoding of accumulated screencast frames
      const encoded = await this.browser.encodeVideo();
      if (!encoded) return null;
      // Download the encoded mp4
      return await this.browser.getVideoBuffer();
    } catch (err) {
      console.error("[agent] finalizeVideo error:", err);
      return null;
    }
  }

  /** Close the browser. For local mode this finalizes the video recording. */
  async close(): Promise<void> {
    try { await this.browser.close(); } catch { /* best effort */ }
  }

  /* ── Continuous page discovery ── */

  private normalizeUrl(url: string): string {
    try { const u = new URL(url); return `${u.origin}${u.pathname}`.replace(/\/$/, ""); } catch { return url; }
  }

  private shouldSkipUrl(url: string): boolean {
    return SKIP_URL_PATTERNS.some((p) => p.test(url));
  }

  private queueDiscoverPage(url: string): void {
    const normalized = this.normalizeUrl(url);
    if (this.discoveredUrls.has(normalized)) return;
    if (this.discoveredUrls.size >= MAX_DISCOVERED_PAGES) return;
    if (this.shouldSkipUrl(url)) return;
    this.discoveredUrls.add(normalized);
    this.pendingDiscoveryUrls.push(normalized);
  }

  private async flushDiscovery(): Promise<void> {
    if (this.browserBusy || this.pendingDiscoveryUrls.length === 0) return;
    if (this.activeDiscoveries >= MAX_CONCURRENT_DISCOVERIES) return;

    const urls = this.pendingDiscoveryUrls.splice(0);
    for (const normalized of urls) {
      try {
        const snapshotText = await this.browser.snapshot();
        const screenshotData = await this.browser.screenshot();

        this.emit("page_discovered", { url: normalized, title: "", screenshot: screenshotData });

        this.activeDiscoveries++;
        this.generateDiscoveryCases(normalized, snapshotText, screenshotData)
          .catch(() => {})
          .finally(() => { this.activeDiscoveries--; });
        break;
      } catch { /* browser might be mid-navigation */ }
    }
  }

  private async generateDiscoveryCases(url: string, snapshotText: string, screenshot: string | null): Promise<void> {
    const prompt = `Analyze this page and generate test cases.\n\nURL: ${url}\n\nAccessibility Tree:\n${snapshotText.slice(0, 4000)}`;
    let fullText = "";

    if (this.provider === "gemini" && this.gemini) {
      const parts: Array<Record<string, unknown>> = [];
      if (screenshot) parts.push({ inlineData: { mimeType: "image/jpeg", data: screenshot } });
      parts.push({ text: prompt });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (this.gemini.models as any).generateContentStream({
        model: this.model,
        contents: [{ role: "user", parts }],
        config: { systemInstruction: DISCOVERY_SYSTEM_PROMPT },
      });
      for await (const chunk of response) {
        const text = chunk.text || "";
        if (text) { fullText += text; this.emit("discovered_cases_chunk", { url, text: fullText }); }
      }
    } else if (this.anthropic) {
      const content: Anthropic.MessageParam["content"] = [];
      if (screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot } });
      content.push({ type: "text", text: prompt });
      const stream = this.anthropic.messages.stream({
        model: this.model, max_tokens: 1024, system: DISCOVERY_SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      });
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          fullText += event.delta.text; this.emit("discovered_cases_chunk", { url, text: fullText });
        }
      }
    }
    this.emit("discovered_cases_complete", { url, cases: fullText });
  }

  private parseScenarios(text: string): { name: string; steps: string }[] {
    const scenarioRegex = /(?:#?\s*(?:Scenario|Test|Case))\s*\d*[:.]\s*/gi;
    const parts = text.split(scenarioRegex).filter((s) => s.trim());
    if (parts.length > 1) {
      const names = text.match(scenarioRegex) || [];
      return parts.map((steps, i) => ({
        name: (names[i] || `Case ${i + 1}`).replace(/^#\s*/, "").replace(/[:.]\s*$/, "").trim(),
        steps: steps.trim(),
      }));
    }
    return [{ name: "Test Scenario", steps: text.trim() }];
  }

  private async runScenario(
    baseUrl: string, scenarioName: string, scenarioSteps: string,
    isFirstScenario: boolean, previousSummaries: string[]
  ): Promise<ScenarioResult> {
    const startTime = Date.now();
    const steps: TestStep[] = [];
    const assertions: TestAssertion[] = [];
    let stepCounter = 0;
    let completed = false;
    let scenarioSummary = "";
    let scenarioPassed = true;

    // Get initial state via Playwright MCP
    const initialSnapshot = await this.browser.snapshot();
    const initialScreenshot = await this.browser.screenshot();
    if (initialScreenshot) {
      console.log(JSON.stringify({ event: "agent.screenshot.emit", size: initialScreenshot.length, ts: new Date().toISOString() }));
      this.emit("screenshot", { base64: initialScreenshot });
    }

    // Start CDP screencast for high-fps WebSocket streaming when available
    // Skip in local mode: the user sees the headed browser directly
    if (this.broadcastFrame && this.mode !== "local") {
      await this.browser.startScreencast(this.broadcastFrame);
    }

    // Screenshot polling removed: screenshots are now captured only after
    // visual actions (navigate, click, type, select, scroll, press_key)
    // to avoid duplicate/redundant captures that waste tokens and time.

    let contextInfo = "";
    if (!isFirstScenario && previousSummaries.length > 0) {
      contextInfo = `\n\nPrevious Scenarios (browser state carries over):\n${previousSummaries.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
    } else {
      contextInfo = `\nNavigated to: ${baseUrl}`;
    }

    const emailInfo = this.tempEmail ? `\nActive disposable email: ${this.tempEmail.address}` : "";

    const userPrompt = `${contextInfo}${emailInfo}\n\nCurrent page accessibility tree:\n${initialSnapshot}\n\n---\nExecute this test scenario:\n**${scenarioName}**\n${scenarioSteps}\n\nIMPORTANT: Use snapshot refs (e.g. ref="e5") for reliable element targeting. Call snapshot before each interaction to get fresh refs.\nIf login/signup needs email, use create_temp_email first.\n\nAnalyze the page, act, make assertions, call complete_scenario when done.`;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages: any[] = this.provider === "gemini"
      ? [{ role: "user", parts: [
          ...(initialScreenshot ? [{ inlineData: { mimeType: "image/jpeg", data: initialScreenshot } }] : []),
          { text: userPrompt },
        ] }]
      : [{ role: "user", content: [
          ...(initialScreenshot ? [{ type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: initialScreenshot } }] : []),
          { type: "text" as const, text: userPrompt },
        ] }];

    // Agent loop
    while (!completed && stepCounter < MAX_STEPS_PER_SCENARIO) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let toolCalls: { id: string; name: string; args: Record<string, unknown> }[] = [];

      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (this.provider === "gemini" && this.gemini) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const response = await (this.gemini.models as any).generateContent({
              model: this.model, contents: messages,
              config: { tools: [{ functionDeclarations: GEMINI_FUNCTION_DECLARATIONS }], systemInstruction: SYSTEM_PROMPT },
            });
            const candidate = response?.candidates?.[0];
            if (!candidate?.content?.parts) break;
            const parts = candidate.content.parts;
            messages.push({ role: "model", parts });
            for (const p of parts) { if (p.text?.trim()) this.emit("reasoning", { text: p.text }); }
            toolCalls = parts.filter((p: { functionCall?: unknown }) => p.functionCall).map((p: { functionCall: { name: string; args: Record<string, unknown> } }) => ({
              id: `gemini_${Date.now()}_${Math.random()}`, name: p.functionCall.name, args: p.functionCall.args || {},
            }));
          } else if (this.anthropic) {
            const response = await this.anthropic.messages.create({
              model: this.model, max_tokens: 4096, system: SYSTEM_PROMPT, tools: TOOLS, messages,
            });
            const content: Anthropic.ContentBlock[] = response.content;
            for (const b of content) { if (b.type === "text" && b.text.trim()) this.emit("reasoning", { text: b.text }); }
            messages.push({ role: "assistant", content });
            toolCalls = content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({
              id: b.id, name: b.name, args: b.input as Record<string, unknown>,
            }));
            if (toolCalls.length === 0 && response.stop_reason === "end_turn") { completed = true; }
          }
          break;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          const isRetryable = /529|429|503|overloaded|rate/i.test(msg);
          if (isRetryable && attempt < 3) {
            const delay = (attempt + 1) * 5000;
            this.emit("reasoning", { text: `API busy (attempt ${attempt + 1}/4), retrying in ${delay / 1000}s...` });
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          const isFatal = /tool_use|tool_result|invalid_request/i.test(msg);
          if (isFatal) {
            this.emit("reasoning", { text: `API error, ending scenario: ${msg.slice(0, 200)}` });
            scenarioPassed = false;
            scenarioSummary = `API error: ${msg.slice(0, 200)}`;
            completed = true;
            break;
          }
          throw err;
        }
      }

      if (toolCalls.length === 0) break;

      // Execute each tool call
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const toolResults: any[] = [];

      for (const toolCall of toolCalls) {
        this.browserBusy = true;
        const toolInput = toolCall.args;
        stepCounter++;

        let result = "";
        let stepAction = toolCall.name;
        let stepDescription = "";
        let stepStatus: "completed" | "failed" = "completed";

        this.emit("step", { id: stepCounter, action: toolCall.name, description: `Executing ${toolCall.name}...`, status: "running", timestamp: Date.now() });

        try {
          switch (toolCall.name) {
            case "navigate": {
              let navUrl = (toolInput.url as string) || "";
              if (navUrl.startsWith("/")) {
                const urlObj = new URL(baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`);
                navUrl = `${urlObj.origin}${navUrl}`;
              }
              result = await this.browser.navigate(navUrl);
              stepDescription = `Navigate to ${navUrl}`;
              this.queueDiscoverPage(navUrl);
              break;
            }
            case "snapshot": {
              result = await this.browser.snapshot();
              stepDescription = "Get page snapshot (accessibility tree)";
              stepAction = "inspect";
              break;
            }
            case "click": {
              const element = toolInput.element as string;
              const ref = toolInput.ref as string | undefined;
              result = await this.browser.click(element, ref);
              stepDescription = `Click "${element}"${ref ? ` [ref=${ref}]` : ""}`;
              break;
            }
            case "type_text": {
              const element = toolInput.element as string;
              const text = toolInput.text as string;
              const ref = toolInput.ref as string | undefined;
              result = await this.browser.type(element, text, ref);
              stepDescription = `Type "${text}" into "${element}"`;
              break;
            }
            case "select_option": {
              const element = toolInput.element as string;
              const values = (toolInput.values as string[]) || [toolInput.value as string];
              result = await this.browser.selectOption(element, values);
              stepDescription = `Select "${values.join(", ")}" in "${element}"`;
              break;
            }
            case "scroll": {
              const x = (toolInput.x as number) || 0;
              const y = (toolInput.y as number) || 400;
              result = await this.browser.scroll(x, y);
              stepDescription = `Scroll ${y > 0 ? "down" : "up"} by ${Math.abs(y)}px`;
              break;
            }
            case "press_key": {
              const key = toolInput.key as string;
              result = await this.browser.pressKey(key);
              stepDescription = `Press ${key}`;
              break;
            }
            case "wait": {
              if (toolInput.text) {
                result = await this.browser.waitForText(toolInput.text as string, (toolInput.ms as number) || 10000);
                stepDescription = `Wait for text "${toolInput.text}"`;
              } else {
                const ms = Math.min((toolInput.ms as number) || 1000, 10000);
                await new Promise((r) => setTimeout(r, ms));
                result = `Waited ${ms}ms`;
                stepDescription = `Wait ${ms}ms`;
              }
              break;
            }
            case "screenshot": {
              const data = await this.browser.screenshot();
              if (data) {
                this.emit("screenshot", { base64: data });
                result = "Screenshot taken and sent to client.";
              } else {
                result = "Screenshot failed.";
              }
              stepDescription = "Take screenshot";
              stepAction = "inspect";
              break;
            }
            case "evaluate": {
              const expr = toolInput.expression as string;
              result = await this.browser.evaluate(expr);
              stepDescription = `Evaluate JS: ${expr.slice(0, 80)}`;
              stepAction = "inspect";
              break;
            }
            case "create_temp_email": {
              this.tempEmail = await DisposableEmail.create();
              result = `Created disposable email: ${this.tempEmail.address}\nUse this EXACT email in signup forms.`;
              stepDescription = `Created temp email: ${this.tempEmail.address}`;
              stepAction = "email";
              this.emit("reasoning", { text: `Disposable email created: ${this.tempEmail.address}` });
              break;
            }
            case "wait_for_verification_code": {
              if (!this.tempEmail) { result = "Error: Call create_temp_email first."; stepStatus = "failed"; stepDescription = "No temp email"; break; }
              const timeout = Math.min(((toolInput.timeout_seconds as number) || 60) * 1000, 120000);
              stepDescription = `Waiting for code at ${this.tempEmail.address}...`;
              this.emit("step", { id: stepCounter, action: "email", description: stepDescription, status: "running", timestamp: Date.now() });
              const cr = await this.tempEmail.waitForVerificationCode(timeout, 3000);
              if (cr?.code) {
                result = `Verification code received: ${cr.code}\nFrom: ${cr.from}\nSubject: ${cr.subject}`;
                stepDescription = `Received code: ${cr.code}`;
                stepAction = "email";
              } else if (cr) {
                result = `Email received but no code pattern found.\nFrom: ${cr.from}\nSubject: ${cr.subject}\nBody: ${cr.body}`;
                stepDescription = "Email received, manual extraction needed";
                stepAction = "email";
              } else {
                result = `No email within ${timeout / 1000}s.`;
                stepStatus = "failed";
                stepDescription = "Verification email timeout";
                stepAction = "email";
              }
              break;
            }
            case "check_email_inbox": {
              if (!this.tempEmail) { result = "Error: Call create_temp_email first."; stepStatus = "failed"; stepDescription = "No temp email"; break; }
              const msgs = await this.tempEmail.getMessages();
              if (msgs.length === 0) { result = `Inbox empty for ${this.tempEmail.address}.`; }
              else {
                const latest = msgs[msgs.length - 1];
                const body = (latest.body_text || latest.body_html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
                result = `${msgs.length} email(s). Latest from: ${latest.from} | Subject: ${latest.subject}\nBody: ${body.slice(0, 500)}`;
              }
              stepDescription = `Check inbox (${msgs.length} emails)`;
              stepAction = "email";
              break;
            }
            case "assert": {
              const desc = toolInput.description as string;
              const passed = toolInput.passed as boolean;
              const evidence = toolInput.evidence as string;
              assertions.push({ description: desc, passed, evidence });
              result = `Assertion ${passed ? "PASSED" : "FAILED"}: ${desc} — ${evidence}`;
              stepDescription = `Assert: ${desc}`;
              stepAction = passed ? "assert_pass" : "assert_fail";
              if (!passed) scenarioPassed = false;
              this.emit("assertion", { description: desc, passed, evidence });
              break;
            }
            case "complete_scenario": {
              scenarioSummary = toolInput.summary as string;
              scenarioPassed = toolInput.passed as boolean;
              completed = true;
              result = "Scenario complete";
              stepDescription = "Scenario complete";
              stepAction = "complete";
              break;
            }
            case "suggest_improvement": {
              const title = toolInput.title as string;
              const severity = toolInput.severity as string;
              const desc = toolInput.description as string;
              const suggestion = toolInput.suggestion as string;
              this.emit("improvement_suggestion", { title, severity, description: desc, suggestion });
              result = `Improvement logged: ${title}`;
              stepDescription = `Issue: ${title}`;
              stepAction = "suggestion";
              break;
            }
            case "http_request": {
              const reqUrl = toolInput.url as string;
              const method = ((toolInput.method as string) || "GET").toUpperCase();
              const headers = (toolInput.headers as Record<string, string>) || {};
              const body = toolInput.body as string | undefined;
              try {
                const fetchOptions: RequestInit = {
                  method,
                  headers: { "Content-Type": "application/json", ...headers },
                };
                if (body && method !== "GET" && method !== "HEAD") {
                  fetchOptions.body = body;
                }
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000);
                fetchOptions.signal = controller.signal;
                const resp = await fetch(reqUrl, fetchOptions);
                clearTimeout(timeoutId);
                const respText = await resp.text();
                const truncated = respText.length > 4000 ? respText.slice(0, 4000) + "\n...(truncated)" : respText;
                result = `HTTP ${resp.status} ${resp.statusText}\n\n${truncated}`;
                stepDescription = `${method} ${reqUrl} → ${resp.status}`;
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                result = `HTTP request failed: ${msg}`;
                stepStatus = "failed";
                stepDescription = `${method} ${reqUrl} failed`;
              }
              stepAction = "http";
              break;
            }
            case "wait_for_stable": {
              const timeoutSec = Math.min((toolInput.timeout_seconds as number) || 30, 60);
              const stableSec = Math.min((toolInput.stable_seconds as number) || 2, 10);
              stepDescription = `Wait for page to stabilize (${stableSec}s quiet, ${timeoutSec}s max)`;
              this.emit("step", { id: stepCounter, action: "wait", description: stepDescription, status: "running", timestamp: Date.now() });
              try {
                // Inject MutationObserver and poll for stability
                await this.browser.evaluate(`
                  window.__assrt_mutations = 0;
                  window.__assrt_observer = new MutationObserver((mutations) => {
                    window.__assrt_mutations += mutations.length;
                  });
                  window.__assrt_observer.observe(document.body, {
                    childList: true, subtree: true, characterData: true
                  });
                `);
                const startMs = Date.now();
                const timeoutMs = timeoutSec * 1000;
                const stableMs = stableSec * 1000;
                let lastMutationCount = -1;
                let stableSince = Date.now();

                while (Date.now() - startMs < timeoutMs) {
                  await new Promise((r) => setTimeout(r, 500));
                  const countStr = await this.browser.evaluate("window.__assrt_mutations");
                  const count = parseInt(countStr, 10) || 0;
                  if (count !== lastMutationCount) {
                    lastMutationCount = count;
                    stableSince = Date.now();
                  } else if (Date.now() - stableSince >= stableMs) {
                    break;
                  }
                }
                // Cleanup
                await this.browser.evaluate(`
                  if (window.__assrt_observer) { window.__assrt_observer.disconnect(); }
                  delete window.__assrt_mutations;
                  delete window.__assrt_observer;
                `);
                const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
                const stable = (Date.now() - stableSince) >= stableMs;
                result = stable
                  ? `Page stabilized after ${elapsed}s (${lastMutationCount} total mutations)`
                  : `Timed out after ${timeoutSec}s (page still changing, ${lastMutationCount} mutations)`;
                stepDescription = stable ? `Page stable after ${elapsed}s` : `Stability timeout after ${timeoutSec}s`;
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                result = `wait_for_stable failed: ${msg}`;
                stepStatus = "failed";
                stepDescription = "wait_for_stable failed";
              }
              stepAction = "wait";
              break;
            }
            default: result = `Unknown: ${toolCall.name}`; stepDescription = `Unknown: ${toolCall.name}`;
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // On failure, get a fresh snapshot for context
          let snapshotText = "";
          try { snapshotText = await this.browser.snapshot(); } catch { /* */ }
          result = `Error: ${msg}\n\nThe action "${toolCall.name}" failed. Current page accessibility tree:\n${snapshotText.slice(0, 2000)}\n\nPlease call snapshot and try a different approach.`;
          stepStatus = "failed";
          stepDescription = `${toolCall.name} failed: ${msg.slice(0, 100)}`;
        }

        // Screenshot after visual actions
        let screenshotData: string | null = null;
        if (!["snapshot", "wait", "wait_for_stable", "assert", "complete_scenario", "create_temp_email", "wait_for_verification_code", "check_email_inbox", "screenshot", "evaluate", "http_request"].includes(toolCall.name)) {
          try { screenshotData = await this.browser.screenshot(); if (screenshotData) { console.log(JSON.stringify({ event: "agent.screenshot.emit", size: screenshotData.length, ts: new Date().toISOString() })); this.emit("screenshot", { base64: screenshotData }); } } catch { /* */ }
        }

        steps.push({ id: stepCounter, action: stepAction, description: stepDescription, status: stepStatus, timestamp: Date.now() });
        this.emit("step", { id: stepCounter, action: stepAction, description: stepDescription, status: stepStatus, timestamp: Date.now() });

        // Build tool result
        if (this.provider === "gemini") {
          toolResults.push({ functionResponse: { name: toolCall.name, response: { result } } });
        } else {
          const toolResultContent: Anthropic.ToolResultBlockParam["content"] = [{ type: "text", text: result }];
          if (screenshotData) {
            toolResultContent.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshotData } });
          }
          toolResults.push({ type: "tool_result", tool_use_id: toolCall.id, content: toolResultContent });
        }

        this.browserBusy = false;
      }

      await this.flushDiscovery().catch(() => {});

      // Add tool results to messages
      if (this.provider === "gemini") {
        messages.push({ role: "function", parts: toolResults });
        const latestScreenshot = await this.browser.screenshot();
        const latestSnapshot = await this.browser.snapshot();
        messages.push({ role: "user", parts: [
          ...(latestScreenshot ? [{ inlineData: { mimeType: "image/jpeg", data: latestScreenshot } }] : []),
          { text: `Current page accessibility tree:\n${latestSnapshot.slice(0, 3000)}\n\nContinue with the test scenario.` },
        ] });
      } else {
        messages.push({ role: "user", content: toolResults });
      }

      // Sliding window: keep only the first user message + most recent turns.
      // Must cut at assistant/model boundaries to avoid orphaning tool_use/tool_result pairs.
      // For Anthropic: messages alternate [user, assistant(tool_use), user(tool_result), assistant, user, ...]
      // We must never separate an assistant tool_use from its following user tool_result.
      if (messages.length > MAX_CONVERSATION_TURNS * 2 + 2) {
        const initial = messages.slice(0, 1); // Keep only the first user message
        let cutIdx = messages.length - MAX_CONVERSATION_TURNS * 2;
        if (cutIdx < 1) cutIdx = 1;
        // Walk forward to a safe cut: start of a user message (not a tool_result following assistant tool_use)
        // A safe point is a user message whose previous message is also a user message, or the start.
        while (cutIdx < messages.length - 2) {
          const msg = messages[cutIdx];
          const role = msg.role;
          // Safe to cut at an assistant/model message (it starts a new turn)
          if (role === "assistant" || role === "model") break;
          cutIdx++;
        }
        const recent = messages.slice(cutIdx);
        messages.length = 0;
        messages.push(...initial, ...recent);
      }
    }

    if (!completed) scenarioSummary = `Reached max steps (${MAX_STEPS_PER_SCENARIO})`;

    return { name: scenarioName, passed: scenarioPassed, steps, assertions, summary: scenarioSummary, duration: Date.now() - startTime };
  }
}
