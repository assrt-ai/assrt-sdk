#!/usr/bin/env node
/**
 * Assrt MCP Server: exposes AI-powered QA testing as tools for coding agents.
 *
 * Tools:
 *   assrt_test     — Run QA test scenarios against a URL
 *   assrt_plan     — Auto-generate test scenarios from a URL
 *   assrt_diagnose — Diagnose a failed test scenario
 *
 * Usage:
 *   npx assrt-mcp               (stdio transport, for Claude Code / Cursor / etc.)
 *   echo '{"jsonrpc":"2.0",...}' | npx tsx src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { getCredential } from "../core/keychain";
import { TestAgent } from "../core/agent";
import { McpBrowserManager, ExtensionTokenRequired } from "../core/browser";
import { fetchScenario, saveScenario, updateScenario, saveScenarioRun, uploadArtifacts, buildCloudUrls } from "../core/scenario-store";
import { writeScenarioFile, writeResultsFile, readScenarioFile, PATHS } from "../core/scenario-files";
import type { TestReport } from "../core/types";
import { trackEvent, shutdownTelemetry } from "../core/telemetry";

// ── Singleton browser instance (reused across assrt_test calls) ──
let sharedBrowser: McpBrowserManager | null = null;

// ── Video player HTML generator ──

function generateVideoPlayerHtml(
  videoFilename: string,
  testUrl: string,
  passedCount: number,
  failedCount: number,
  durationSec: number,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Assrt Test Recording</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0a0a0f; color: #e5e7eb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; flex-direction: column; height: 100vh; padding: 8px; }
  .header { width: 100%; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; padding: 0 8px; flex-shrink: 0; }
  .brand { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
  .brand span { color: #22c55e; }
  .meta { display: flex; gap: 16px; font-size: 13px; color: #9ca3af; }
  .meta .pass { color: #22c55e; font-weight: 600; }
  .meta .fail { color: #ef4444; font-weight: 600; }
  .video-wrap { width: 100%; flex: 1; min-height: 0; background: #111118; border-radius: 12px; overflow: hidden; border: 1px solid #1f1f2e; display: flex; flex-direction: column; }
  video { width: 100%; flex: 1; min-height: 0; object-fit: contain; display: block; }
  .controls { padding: 8px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; flex-shrink: 0; }
  .speed-group { display: flex; gap: 4px; }
  .speed-btn { background: #1a1a26; border: 1px solid #2a2a3a; color: #9ca3af; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.15s; }
  .speed-btn:hover { background: #252536; color: #e5e7eb; }
  .speed-btn.active { background: #22c55e; color: #0a0a0f; border-color: #22c55e; font-weight: 700; }
  .hint { margin-left: auto; font-size: 12px; color: #6b7280; }
  kbd { background: #1a1a26; border: 1px solid #2a2a3a; border-radius: 4px; padding: 1px 6px; font-size: 11px; font-family: inherit; }
</style>
</head>
<body>
<div class="header">
  <div class="brand">assrt<span>.</span></div>
  <div class="meta">
    <span>${testUrl}</span>
    <span class="pass">${passedCount} passed</span>
    ${failedCount > 0 ? `<span class="fail">${failedCount} failed</span>` : ''}
    <span>${durationSec}s</span>
  </div>
</div>
<div class="video-wrap">
  <video id="v" controls autoplay muted>
    <source src="${videoFilename}" type="video/webm">
  </video>
  <div class="controls">
    <div class="speed-group">
      <button class="speed-btn" data-speed="1">1x</button>
      <button class="speed-btn" data-speed="2">2x</button>
      <button class="speed-btn" data-speed="3">3x</button>
      <button class="speed-btn active" data-speed="5">5x</button>
      <button class="speed-btn" data-speed="10">10x</button>
    </div>
    <div class="hint"><kbd>Space</kbd> play/pause &nbsp; <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>5</kbd> speed &nbsp; <kbd>\u2190</kbd><kbd>\u2192</kbd> seek 5s</div>
  </div>
</div>
<script>
const v = document.getElementById('v');
const btns = document.querySelectorAll('.speed-btn');
function setSpeed(s) {
  v.playbackRate = s;
  btns.forEach(b => b.classList.toggle('active', +b.dataset.speed === s));
}
v.addEventListener('loadeddata', () => setSpeed(5));
btns.forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
document.addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); }
  if (e.key === 'ArrowRight') { v.currentTime += 5; }
  const speedMap = { '1': 1, '2': 2, '3': 3, '5': 5, '0': 10 };
  if (speedMap[e.key]) setSpeed(speedMap[e.key]);
});
</script>
</body>
</html>`;
}

// ── Persistent video server (single instance, supports Range requests for seeking) ──

let videoServerPort: number | null = null;
let videoServerInstance: import("http").Server | null = null;

async function ensureVideoServer(): Promise<number> {
  if (videoServerPort && videoServerInstance) return videoServerPort;

  const http = await import("http");
  const fs = await import("fs");
  const pathMod = await import("path");
  const mime: Record<string, string> = { ".html": "text/html", ".webm": "video/webm", ".mp4": "video/mp4" };

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const dir = url.searchParams.get("dir");

    // Serve the player HTML (no dir needed for the player itself)
    if (url.pathname === "/player.html" && dir) {
      try {
        const playerPath = pathMod.join(dir, "player.html");
        const data = fs.readFileSync(playerPath, "utf-8");
        // Rewrite the video src to include the dir param
        const videoFiles = fs.readdirSync(dir).filter((f: string) => f.endsWith(".webm"));
        const rewritten = videoFiles.length > 0
          ? data.replace(
              `src="${videoFiles[0]}"`,
              `src="/video/${encodeURIComponent(videoFiles[0])}?dir=${encodeURIComponent(dir)}"`,
            )
          : data;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(rewritten);
      } catch {
        res.writeHead(404);
        res.end("Player not found");
      }
      return;
    }

    // Serve video files with Range support for seeking
    if (url.pathname.startsWith("/video/") && dir) {
      const filename = decodeURIComponent(url.pathname.slice("/video/".length));
      const filePath = pathMod.join(dir, pathMod.basename(filename));
      const ext = pathMod.extname(filePath).toLowerCase();
      const contentType = mime[ext] || "application/octet-stream";

      let stat: ReturnType<typeof fs.statSync>;
      try {
        stat = fs.statSync(filePath);
      } catch {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const rangeHeader = req.headers.range;
      if (rangeHeader) {
        const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          if (start >= stat.size) {
            res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
            res.end();
            return;
          }
          const clampedEnd = Math.min(end, stat.size - 1);
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${clampedEnd}/${stat.size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": clampedEnd - start + 1,
            "Content-Type": contentType,
          });
          fs.createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
          return;
        }
      }

      // Full response
      res.writeHead(200, {
        "Content-Length": stat.size,
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  await new Promise<void>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      videoServerPort = (srv.address() as { port: number }).port;
      videoServerInstance = srv;
      console.error(`[assrt-mcp] Video player server started on port ${videoServerPort}`);
      resolve();
    });
  });
  // Keep alive for the lifetime of the MCP process (no timeout, no unref)
  return videoServerPort!;
}

// ── Plan generation prompt (reused from web app) ──

const PLAN_SYSTEM_PROMPT = `You are a Senior QA Engineer generating test cases for an AI browser agent. The agent can: navigate URLs, click buttons/links by text or selector, type into inputs, scroll, press keys, and make assertions. It CANNOT: resize the browser, test network errors, inspect CSS, or run JavaScript.

## Output Format
Generate test cases in this EXACT format:

#Case 1: [short action-oriented name]
[Step-by-step instructions the agent can execute. Be SPECIFIC about what to click, what to type, and what to verify.]

#Case 2: [short action-oriented name]
[Step-by-step instructions...]

## CRITICAL Rules for Executable Tests
1. **Each case must be SELF-CONTAINED** — do not assume previous cases ran. If a test needs login, include the login steps.
2. **Be specific about selectors** — say "click the Login button" not "navigate to login". Say "type test@email.com into the email field" not "fill in credentials".
3. **Verify observable things** — check for visible text, page titles, URLs, element presence. NOT for CSS, colors, performance, or responsive layout.
4. **Keep cases SHORT** — 3-5 actions max per case. A focused test that passes is better than a complex one that fails.
5. **Avoid testing what you can't see** — don't generate cases for features behind authentication unless there's a visible signup/login form.
6. **Generate 5-8 cases max** — focused on the MOST IMPORTANT user flows visible on the page.`;

// ── Diagnosis prompt (reused from fix-case route) ──

const DIAGNOSE_SYSTEM_PROMPT = `You are a senior QA engineer and debugging expert. You are given a failing test case report from an automated web testing agent. Your job is to:

1. **Diagnose** the root cause — is it a bug in the application, a flawed test, or an environment issue?
2. **Provide a fix** — give a concrete, actionable solution:
   - If the app has a bug: describe what the app should do differently
   - If the test is flawed: provide a corrected test scenario in the exact #Case format
   - If it's an environment issue: explain what needs to change
3. **Provide a corrected test scenario** if the test itself needs adjustment

## Output Format

### Root Cause
[1-2 sentences identifying the core issue]

### Analysis
[3-5 sentences explaining what went wrong and why]

### Recommended Fix
[Concrete steps to fix the issue]

### Corrected Test Scenario
#Case 1: [corrected case name]
[corrected steps that will pass]

## Rules
- Be specific — reference actual elements, URLs, error messages from the report
- If the test failed because a feature doesn't exist, say so clearly
- If the test steps are valid but the app is broken, focus on the app issue
- Keep it concise and actionable — no filler`;

// ── State: last recorded video path (set by assrt_test, read by assrt_analyze_video) ──

let lastVideoFile: string | null = null;

// ── Server setup ──

const SERVER_INSTRUCTIONS = `You are connected to Assrt, an AI-powered QA testing server that runs real browser tests against web applications.

## When to use Assrt

**Proactively use Assrt after any user-facing change.** Do not wait for the user to ask for testing. Specifically:

1. **After implementing a feature or bug fix** that touches UI, routes, forms, or user flows: run \`assrt_test\` against the local dev server to verify the change works end-to-end in a real browser.
2. **Before committing code**: if the changes affect anything a user would see or interact with, generate a quick test with \`assrt_plan\` or write a targeted test case and run it with \`assrt_test\`.
3. **When a test fails**: use \`assrt_diagnose\` to understand root cause before attempting a fix. Do not guess.

## How to use the tools

- **assrt_test**: The primary tool. Pass a URL and either a \`plan\` (text) or a \`scenarioId\` (UUID from a previous run). Returns structured pass/fail results with screenshots.
- **assrt_plan**: Use when you need test cases but don't have them. Navigates to the URL, analyzes the page, and generates executable test scenarios.
- **assrt_diagnose**: Use after a failed test. Pass the URL, the scenario that failed, and the error. Returns root cause analysis and a corrected test.

## Scenario files

After \`assrt_test\` runs, the test plan is saved to \`/tmp/assrt/scenario.md\` and results to \`/tmp/assrt/results/latest.json\`. You can:
- **Read** \`/tmp/assrt/scenario.md\` to see the current plan
- **Edit** \`/tmp/assrt/scenario.md\` to modify test cases; changes auto-sync to cloud storage
- **Read** \`/tmp/assrt/results/latest.json\` to review the last run's results
- **Read** \`/tmp/assrt/scenario.json\` for scenario metadata (ID, name, URL)

Every test run is auto-saved with a unique scenario ID (UUID). Use this ID to re-run the same scenario later: \`assrt_test({url, scenarioId: "..."})\`.

## Extension mode (reuse existing Chrome)

Pass \`extension: true\` to connect to the user's running Chrome (with their logins, cookies, tabs) instead of launching a new browser. On first use, if no token is saved, the response will contain setup instructions and an \`extension_token_required\` error. Ask the user to paste the token, then retry with \`extensionToken\` set. The token is saved automatically for future runs.

## Important

- Always include the correct local dev server URL. Check package.json scripts or running processes to find it.
- Test plans use \`#Case N: name\` format. Each case should be self-contained (3-5 steps).
- The browser runs headless by default at 1600x900. Pass \`headed: true\` to \`assrt_test\` (or set \`ASSRT_HEADED=1\`) to launch a visible browser window, useful when debugging a failing test locally. Screenshots are returned as images in the response.
- If the dev server is not running, start it first before calling assrt_test.

## Non-blocking CLI alternative

The MCP tools (\`assrt_test\`, \`assrt_plan\`) block the conversation until they finish. To run tests without blocking, use the \`assrt\` CLI via the Bash tool with \`run_in_background: true\`:

\`\`\`bash
npx assrt run --url http://localhost:3000 --extension --video --plan "#Case: Login flow
- Navigate to the login page
- Enter test credentials
- Verify dashboard loads" --json
\`\`\`

Key flags: \`--video\` records a video and auto-opens the player, \`--no-auto-open\` records without opening, \`--extension\` reuses existing Chrome, \`--json\` outputs structured results (includes \`videoPlayerUrl\`).

Use this when you want to continue working while tests run in the background.`;

const server = new McpServer(
  { name: "assrt", version: "0.2.0" },
  { instructions: SERVER_INSTRUCTIONS },
);

// ── Tool: assrt_test ──

server.tool(
  "assrt_test",
  "Run AI-powered QA test scenarios against a URL. Returns a structured report with pass/fail results, assertions, and improvement suggestions.",
  {
    url: z.string().optional().describe("URL to test (e.g. http://localhost:3000). Optional when continuing in an existing browser session."),
    plan: z.string().optional().describe("Test scenarios in text format. Use #Case N: format for multiple scenarios. Either plan or scenarioId is required."),
    scenarioId: z.string().optional().describe("Load a saved scenario by its UUID instead of providing plan text. Get this ID from a previous assrt_test run or the Assrt web app."),
    scenarioName: z.string().optional().describe("Human-readable name for saving this scenario (e.g. 'checkout flow'). Used when auto-saving new scenarios."),
    passCriteria: z.string().optional().describe("Explicit pass/fail criteria the agent MUST verify. Free text describing success conditions (e.g. 'Cart total shows $42.99', 'User is redirected to /dashboard', 'Error toast does NOT appear'). The test fails if any criterion is not met."),
    variables: z.record(z.string(), z.string()).optional().describe("Key/value pairs for parameterized tests. Variables are interpolated into the plan text as {{KEY}} and also shown to the agent. Example: {\"EMAIL\": \"test@example.com\", \"SKU\": \"PROD-001\"}"),
    timeout: z.number().optional().describe("Maximum seconds before the test run is aborted (default: no limit). Useful for ensuring fast flows stay fast."),
    viewport: z.union([
      z.string().describe("Viewport preset: 'mobile' (375x812) or 'desktop' (1440x900)"),
      z.object({ width: z.number(), height: z.number() }).describe("Explicit viewport dimensions"),
    ]).optional().describe("Browser viewport size. Pass a preset string ('mobile', 'desktop') or explicit {width, height}."),
    tags: z.array(z.string()).optional().describe("Tags for organizing scenarios (e.g. ['smoke', 'checkout', 'regression']). Saved with the scenario for filtering."),
    model: z.string().optional().describe("LLM model override (default: claude-haiku-4-5-20251001)"),
    autoOpenPlayer: z.boolean().optional().describe("Auto-open the video player in the browser when test completes (default: true)"),
    headed: z.boolean().optional().describe("Launch a visible (headed) browser window instead of headless. Defaults to headless, or the ASSRT_HEADED env var if set."),
    isolated: z.boolean().optional().describe("When true, keep the browser profile in memory only (no disk persistence). When false (default), persist cookies, localStorage, and logins to ~/.assrt/browser-profile across test runs."),
    keepBrowserOpen: z.boolean().optional().describe("When true, leave the browser window open after the test finishes instead of closing it. Useful for manual inspection or follow-up testing. Defaults to false."),
    extension: z.boolean().optional().describe("When true, connect to your existing Chrome browser instance instead of launching a new one. Uses Playwright's --extension mode via Chrome DevTools Protocol."),
    extensionToken: z.string().optional().describe("Playwright extension token for bypassing the Chrome approval dialog. Required on first use of extension mode. The token is saved automatically for future runs."),
  },
  async ({ url: urlParam, plan, scenarioId, scenarioName, passCriteria: passCriteriaParam, variables: variablesParam, timeout, viewport, tags: tagsParam, model, autoOpenPlayer, headed, isolated, keepBrowserOpen, extension, extensionToken }) => {
    // Mutable copies of scenario metadata (may be inherited from stored scenario)
    let passCriteria = passCriteriaParam;
    let variables = variablesParam as Record<string, string> | undefined;
    let tags = tagsParam;

    // If no URL provided, require an existing browser session to continue in
    const url = urlParam || "";
    if (!url && (!sharedBrowser || !sharedBrowser.isConnected)) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "url is required when there is no existing browser session to continue." }) }] };
    }

    // Resolve the plan: either from scenarioId or directly from plan param
    let resolvedPlan: string;
    let resolvedScenarioId = scenarioId;

    if (scenarioId && plan) {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Provide either plan or scenarioId, not both." }) }] };
    }

    if (scenarioId) {
      const stored = await fetchScenario(scenarioId);
      if (!stored) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: `Scenario ${scenarioId} not found.` }) }] };
      }
      resolvedPlan = stored.plan;
      // Inherit stored scenario metadata when not explicitly overridden by the caller
      if (!passCriteria && stored.passCriteria) passCriteria = stored.passCriteria;
      if ((!variables || Object.keys(variables).length === 0) && stored.variables) variables = stored.variables;
      if ((!tags || tags.length === 0) && stored.tags) tags = stored.tags;
      console.error(`[assrt_test] Loaded scenario ${scenarioId.slice(0, 8)}... (${stored.name || "unnamed"})`);
    } else if (plan) {
      resolvedPlan = plan;
    } else {
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Either plan or scenarioId is required." }) }] };
    }

    // Write scenario to disk so the agent can read/edit it via file tools
    writeScenarioFile(resolvedPlan, {
      id: resolvedScenarioId || "unsaved",
      name: scenarioName,
      url,
    });

    const shouldAutoOpen = autoOpenPlayer !== false;
    const autoSave = !process.env.ASSRT_NO_SAVE;
    const credential = getCredential();

    // Pre-flight: create scenario UUID BEFORE test execution so cloud URLs are deterministic
    if (autoSave && !resolvedScenarioId) {
      try {
        resolvedScenarioId = await saveScenario({
          plan: resolvedPlan,
          name: scenarioName,
          url,
          passCriteria,
          variables,
          tags,
          createdFrom: "mcp",
        });
        // Rewrite scenario file with real ID so fs.watch syncs correctly
        writeScenarioFile(resolvedPlan, { id: resolvedScenarioId, name: scenarioName, url });
        console.error(`[assrt_test] Pre-saved scenario as ${resolvedScenarioId.slice(0, 8)}...`);
      } catch (err) {
        console.error("[assrt_test] Pre-save failed:", (err as Error).message);
      }
    }

    // Generate a stable run ID upfront for deterministic cloud URLs
    const crypto = await import("crypto");
    const runId = crypto.randomUUID();
    const runDir = join(tmpdir(), "assrt", runId);
    const screenshotDir = join(runDir, "screenshots");
    mkdirSync(screenshotDir, { recursive: true });

    const logs: string[] = [];
    const allEvents: Array<{ time: string; type: string; data: unknown }> = [];
    const improvements: Array<{ title: string; severity: string; description: string; suggestion: string }> = [];
    const screenshots: Array<{ step: number; action: string; description: string; base64: string; file: string }> = [];
    let currentStep = 0;
    let currentAction = "";
    let currentDescription = "";
    let screenshotIndex = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emit = (type: string, data: any) => {
      const time = new Date().toISOString();
      allEvents.push({ time, type, data: type === "screenshot" ? { step: currentStep, action: currentAction } : data });

      if (type === "status") logs.push(`[${time}] [status] ${data.message}`);
      else if (type === "step") {
        currentStep = data.id || currentStep;
        currentAction = data.action || "";
        currentDescription = data.description || "";
        logs.push(`[${time}] [step ${currentStep}] (${currentAction}) ${currentDescription} — ${data.status || "running"}`);
      } else if (type === "reasoning") {
        logs.push(`[${time}] [reasoning] ${data.text}`);
      } else if (type === "assertion") {
        const icon = data.passed ? "PASS" : "FAIL";
        logs.push(`[${time}] [${icon}] ${data.description}${data.evidence ? ` — ${data.evidence}` : ""}`);
      } else if (type === "scenario_start") {
        logs.push(`[${time}] [scenario_start] ${data.name}`);
      } else if (type === "scenario_complete") {
        const result = data.passed ? "PASSED" : "FAILED";
        logs.push(`[${time}] [${result}] ${data.name}`);
      } else if (type === "improvement_suggestion") {
        logs.push(`[${time}] [issue] ${data.severity}: ${data.title} — ${data.description}`);
        improvements.push({ title: data.title, severity: data.severity, description: data.description, suggestion: data.suggestion });
      } else if (type === "screenshot" && data.base64) {
        // Save screenshot to disk
        const filename = `${String(screenshotIndex).padStart(2, "0")}_step${currentStep}_${currentAction || "init"}.png`;
        const filepath = join(screenshotDir, filename);
        try { writeFileSync(filepath, Buffer.from(data.base64, "base64")); } catch { /* best effort */ }
        screenshotIndex++;

        // Deduplicate: replace if same step, only keep last screenshot per step
        const last = screenshots[screenshots.length - 1];
        if (last && last.step === currentStep) {
          last.base64 = data.base64;
          last.file = filepath;
        } else {
          screenshots.push({
            step: currentStep,
            action: currentAction,
            description: currentDescription,
            base64: data.base64,
            file: filepath,
          });
        }
      }
      // Send progress via server logging
      if (type === "status" || type === "scenario_start") {
        server.server.sendLoggingMessage({
          level: "info",
          data: type === "status" ? data.message : `Starting scenario: ${data.name}`,
        });
      }
    };

    const t0 = Date.now();
    const videoDir = join(runDir, "video");
    const agentMode = "local" as const;
    const headedResolved = headed ?? (process.env.ASSRT_HEADED === "1" || process.env.ASSRT_HEADED === "true");
    const isolatedResolved = isolated ?? (process.env.ASSRT_ISOLATED === "1" || process.env.ASSRT_ISOLATED === "true");

    // Reuse the shared browser only if it's alive (real health check, not just reference check).
    // This prevents reusing a dead browser from a previous run that crashed or timed out.
    if (agentMode === "local") {
      if (sharedBrowser && sharedBrowser.isConnected) {
        const alive = await sharedBrowser.isAlive();
        if (!alive) {
          console.error("[server] shared browser failed health check, closing and creating fresh instance");
          try { await sharedBrowser.close(); } catch { /* best effort */ }
          sharedBrowser = null;
        }
      }
      if (!sharedBrowser || !sharedBrowser.isConnected) {
        sharedBrowser = new McpBrowserManager();
      }
    }
    const extensionResolved = extension ?? false;
    const agent = new TestAgent(credential.token, emit, model, "anthropic", null, agentMode, credential.type, videoDir, headedResolved, isolatedResolved, agentMode === "local" ? sharedBrowser! : undefined, extensionResolved, extensionToken);

    // Ensure the browser is launched before starting video recording.
    // agent.run() calls launchLocal() internally, but we need the browser connected
    // before calling startVideo, so pre-launch it here.
    let videoFilesBefore: string[] = [];
    if (agentMode === "local" && sharedBrowser && !sharedBrowser.isConnected) {
      try {
        await sharedBrowser.launchLocal(videoDir, headedResolved, isolatedResolved, extensionResolved, extensionToken);
      } catch (err) {
        if (err instanceof ExtensionTokenRequired) {
          return { content: [{ type: "text" as const, text: JSON.stringify({
            error: "extension_token_required",
            message: err.message,
            hint: "Ask the user to paste the token, then call assrt_test again with extensionToken parameter set to the token value.",
          }, null, 2) }] };
        }
        throw err;
      }
    }
    // Start video recording for this run (uses devtools capability)
    if (agentMode === "local" && sharedBrowser && sharedBrowser.isConnected) {
      mkdirSync(videoDir, { recursive: true });
      const playwrightOutputDir = sharedBrowser.getOutputDir();
      if (playwrightOutputDir) {
        try { videoFilesBefore = readdirSync(playwrightOutputDir).filter((f) => f.endsWith(".webm")); } catch { /* */ }
      }
      await sharedBrowser.startVideo();
    }

    // Build run options
    const runOptions = { passCriteria, variables, timeout, viewport };

    // Run with optional timeout
    let report: TestReport;
    if (timeout && timeout > 0) {
      const timeoutMs = timeout * 1000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Test run exceeded timeout of ${timeout}s`)), timeoutMs)
      );
      try {
        report = await Promise.race([agent.run(url, resolvedPlan, runOptions), timeoutPromise]);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        report = {
          url,
          scenarios: [{ name: "Timeout", passed: false, steps: [], assertions: [{ description: `Completed within ${timeout}s`, passed: false, evidence: errMsg }], summary: errMsg, duration: timeout * 1000 }],
          totalDuration: timeout * 1000,
          passedCount: 0,
          failedCount: 1,
          generatedAt: new Date().toISOString(),
        };
      }
    } else {
      report = await agent.run(url, resolvedPlan, runOptions);
    }

    // Stop video recording to finalize the file for this run
    if (agentMode === "local" && sharedBrowser) {
      await sharedBrowser.stopVideo();
      // Find the newly created video file in the Playwright output dir and move it to our video dir
      const playwrightOutputDir = sharedBrowser.getOutputDir();
      if (playwrightOutputDir) {
        try {
          const { copyFileSync } = await import("fs");
          const videoFilesAfter = readdirSync(playwrightOutputDir).filter((f) => f.endsWith(".webm"));
          const newVideoFiles = videoFilesAfter.filter((f) => !videoFilesBefore.includes(f));
          if (newVideoFiles.length > 0) {
            const srcPath = join(playwrightOutputDir, newVideoFiles[0]);
            const destPath = join(videoDir, "recording.webm");
            copyFileSync(srcPath, destPath);
            console.error(`[assrt_test] video copied: ${srcPath} -> ${destPath}`);
          }
        } catch (err) { console.error(`[assrt_test] video copy failed: ${(err as Error).message}`); }
      }
      console.error("[assrt_test] browser kept alive for reuse");
    } else {
      await agent.close({ keepBrowserOpen: !!keepBrowserOpen });
    }

    // Write execution log to disk
    const logContent = logs.join("\n");
    const logFile = join(runDir, "execution.log");
    try { writeFileSync(logFile, logContent); } catch { /* best effort */ }

    // Write full event trace to disk
    const eventsFile = join(runDir, "events.json");
    try { writeFileSync(eventsFile, JSON.stringify(allEvents, null, 2)); } catch { /* best effort */ }

    // Find the video file (Playwright saves as .webm in the videoDir)
    let videoFile: string | null = null;
    let videoPlayerFile: string | null = null;
    let videoPlayerUrl: string | null = null;
    try {
      const videoFiles = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
      if (videoFiles.length > 0) {
        videoFile = join(videoDir, videoFiles[0]);
        lastVideoFile = videoFile;
        // Generate a self-contained HTML player alongside the video
        videoPlayerFile = join(videoDir, "player.html");
        writeFileSync(videoPlayerFile, generateVideoPlayerHtml(
          basename(videoFiles[0]),
          url,
          report.passedCount,
          report.failedCount,
          +(report.totalDuration / 1000).toFixed(1),
        ));
        // Serve video via the persistent video server
        try {
          const port = await ensureVideoServer();
          videoPlayerUrl = `http://127.0.0.1:${port}/player.html?dir=${encodeURIComponent(videoDir)}`;
          if (shouldAutoOpen) {
            try { execSync(`open "${videoPlayerUrl}"`); } catch { /* best effort */ }
          }
        } catch { /* best effort */ }
      }
    } catch { /* no video directory or no files */ }

    const summary: Record<string, unknown> = {
      passed: report.failedCount === 0,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      duration: +(report.totalDuration / 1000).toFixed(1),
      ...(passCriteria && { passCriteria }),
      ...(variables && Object.keys(variables).length > 0 && { variables }),
      ...(tags && tags.length > 0 && { tags }),
      ...(viewport && { viewport }),
      ...(timeout && { timeout }),
      screenshotCount: screenshots.length,
      artifactsDir: runDir,
      logFile,
      videoFile,
      videoPlayerFile,
      videoPlayerUrl,
      scenarios: report.scenarios.map((s) => ({
        name: s.name,
        passed: s.passed,
        summary: s.summary,
        assertions: s.assertions.map((a) => ({
          description: a.description,
          passed: a.passed,
          evidence: a.evidence,
        })),
      })),
      improvements: improvements,
    };

    // Build response: JSON summary with screenshot file paths (not inline base64, which can exceed 20MB)
    // Screenshots are saved to disk and can be viewed via the file paths in the summary
    const screenshotFiles = screenshots.map((ss) => ({
      step: ss.step,
      action: ss.action,
      description: ss.description,
      file: ss.file,
    }));
    summary.screenshots = screenshotFiles;

    // Build deterministic cloud URLs (available immediately, artifacts upload in background)
    if (resolvedScenarioId && !resolvedScenarioId.startsWith("local-")) {
      const artifactNames: { video?: string; screenshots?: string[]; log?: string } = {};
      if (videoFile) artifactNames.video = basename(videoFile);
      if (screenshotFiles.length > 0) artifactNames.screenshots = screenshotFiles.map((s) => basename(s.file));
      artifactNames.log = "execution.log";

      const cloudUrls = buildCloudUrls(resolvedScenarioId, runId, artifactNames);
      summary.cloudUrls = cloudUrls;
    }

    // Write results to a well-known file so the agent can access them
    const { latestPath, runPath } = writeResultsFile(runId, summary);
    summary.resultsFile = latestPath;
    summary.runResultsFile = runPath;

    // Include scenario file paths so the agent knows where to find/edit the plan
    summary.scenarioFile = PATHS.scenarioFile;
    summary.scenarioMetaFile = PATHS.scenarioMeta;

    // Re-read the scenario file in case the agent edited it during the run
    const currentPlan = readScenarioFile();
    if (currentPlan && currentPlan !== resolvedPlan) {
      console.error("[assrt_test] Scenario was edited during run, using updated plan for save");
      resolvedPlan = currentPlan;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const content: any[] = [
      { type: "text", text: JSON.stringify(summary, null, 2) },
    ];

    // Attach scenarioId to summary
    if (resolvedScenarioId) {
      summary.scenarioId = resolvedScenarioId;
    }

    // Async: save run result and upload artifacts to central storage (fire and forget)
    if (resolvedScenarioId && !resolvedScenarioId.startsWith("local-")) {
      // If the plan was edited during the run, update the saved scenario
      if (currentPlan && currentPlan !== resolvedPlan) {
        updateScenario(resolvedScenarioId, { plan: resolvedPlan }).catch((err) =>
          console.error("[assrt_test] Async scenario update failed:", (err as Error).message)
        );
      }

      // Save run record
      saveScenarioRun(resolvedScenarioId, {
        planSnapshot: resolvedPlan,
        url,
        model: model || "claude-haiku-4-5-20251001",
        status: report.failedCount === 0 ? "passed" : "failed",
        passedCount: report.passedCount,
        failedCount: report.failedCount,
        totalDuration: report.totalDuration,
        reportJson: summary,
      }).then((savedRunId) => {
        // Upload artifacts in background after run is saved
        if (!savedRunId) return;
        const files: Array<{ name: string; path: string; type: string }> = [];
        if (videoFile) files.push({ name: basename(videoFile), path: videoFile, type: "video/webm" });
        if (logFile) files.push({ name: "execution.log", path: logFile, type: "text/plain" });
        for (const ss of screenshotFiles) {
          files.push({ name: basename(ss.file), path: ss.file, type: "image/png" });
        }
        if (files.length > 0) {
          uploadArtifacts(resolvedScenarioId!, savedRunId, files).catch((err) =>
            console.error("[assrt_test] Artifact upload failed:", (err as Error).message)
          );
        }
      }).catch((err) => console.error("[assrt_test] Async run save failed:", (err as Error).message));
    }

    trackEvent("assrt_test_run", {
      url,
      model: model || "default",
      passed: report.failedCount === 0,
      passedCount: report.passedCount,
      failedCount: report.failedCount,
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      screenshotCount: screenshots.length,
      scenarioCount: report.scenarios.length,
      scenarioId: resolvedScenarioId?.slice(0, 8),
      source: "mcp",
    });

    return { content };
  }
);

// ── Tool: assrt_plan ──

server.tool(
  "assrt_plan",
  "Auto-generate QA test scenarios by analyzing a URL. Launches a browser, takes screenshots, and uses AI to create executable test cases.",
  {
    url: z.string().describe("URL to analyze (e.g. http://localhost:3000)"),
    model: z.string().optional().describe("LLM model override for plan generation"),
  },
  async ({ url, model }) => {
    const t0 = Date.now();
    const credential = getCredential();
    const Anthropic = (await import("@anthropic-ai/sdk")).default;

    const anthropic = new Anthropic({
      authToken: credential.token,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });

    const browser = new McpBrowserManager();
    try {
      server.server.sendLoggingMessage({ level: "info", data: "Launching local browser..." });
      await browser.launchLocal();

      server.server.sendLoggingMessage({ level: "info", data: `Navigating to ${url}...` });
      await browser.navigate(url);

      // Take screenshots at different scroll positions
      const screenshot1 = await browser.screenshot();
      const snapshotText1 = await browser.snapshot();

      await browser.scroll(0, 800);
      await new Promise((r) => setTimeout(r, 500));
      const screenshot2 = await browser.screenshot();
      const snapshotText2 = await browser.snapshot();

      await browser.scroll(0, 800);
      await new Promise((r) => setTimeout(r, 500));
      const screenshot3 = await browser.screenshot();
      const snapshotText3 = await browser.snapshot();

      await browser.close();

      const allText = [snapshotText1, snapshotText2, snapshotText3].join("\n\n").slice(0, 8000);

      server.server.sendLoggingMessage({ level: "info", data: "Generating test plan with AI..." });

      // Build message content with screenshots
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contentParts: any[] = [];
      for (const img of [screenshot1, screenshot2, screenshot3]) {
        if (img) {
          contentParts.push({
            type: "image",
            source: { type: "base64", media_type: "image/jpeg", data: img },
          });
        }
      }
      contentParts.push({
        type: "text",
        text: `Analyze this web application and generate a comprehensive test plan.\n\n**URL:** ${url}\n\n**Visible Text Content:**\n${allText}\n\nBased on the screenshots and page analysis above, generate comprehensive test cases for this web application.`,
      });

      const response = await anthropic.messages.create({
        model: model || "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: PLAN_SYSTEM_PROMPT,
        messages: [{ role: "user", content: contentParts }],
      });

      const plan = response.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");

      trackEvent("assrt_plan_run", {
        url,
        model: model || "default",
        duration_s: +((Date.now() - t0) / 1000).toFixed(1),
        source: "mcp",
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ plan, url }, null, 2),
          },
        ],
      };
    } catch (err) {
      try { await browser.close(); } catch { /* already closed */ }
      trackEvent("assrt_plan_error", { url, error: (err as Error).message?.slice(0, 200), source: "mcp" });
      throw err;
    }
  }
);

// ── Tool: assrt_diagnose ──

server.tool(
  "assrt_diagnose",
  "Diagnose a failed test scenario. Analyzes the failure and suggests fixes for both application bugs and flawed tests.",
  {
    url: z.string().describe("URL that was tested"),
    scenario: z.string().describe("The test scenario that failed"),
    error: z.string().describe("The failure description, evidence, or error message"),
  },
  async ({ url, scenario, error }) => {
    const t0 = Date.now();
    const credential = getCredential();
    const Anthropic = (await import("@anthropic-ai/sdk")).default;

    const anthropic = new Anthropic({
      authToken: credential.token,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });

    const debugPrompt = `## Failed Test Report

**URL:** ${url}

**Test Scenario:**
${scenario}

**Failure:**
${error}

Please diagnose this failure and provide a corrected test scenario.`;

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      system: DIAGNOSE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: debugPrompt }],
    });

    const diagnosis = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");

    trackEvent("assrt_diagnose_run", {
      url,
      duration_s: +((Date.now() - t0) / 1000).toFixed(1),
      source: "mcp",
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ diagnosis, url, scenario }, null, 2),
        },
      ],
    };
  }
);

// ── Tool: assrt_analyze_video (only registered when GEMINI_API_KEY is available) ──

const GEMINI_VIDEO_MODEL = "gemini-3.1-flash-lite-preview";

if (process.env.GEMINI_API_KEY) {
  server.tool(
    "assrt_analyze_video",
    "Analyze the most recent test recording video using Gemini vision. Ask questions about what happened during the test, verify visual states, or get a summary of the browser session.",
    {
      prompt: z.string().describe("What to analyze in the video (e.g. 'Did the login form appear?', 'Summarize what happened', 'Was there a visual error?')"),
      videoPath: z.string().optional().describe("Path to a specific .webm video file. If omitted, uses the most recent assrt_test recording."),
    },
    async ({ prompt, videoPath }) => {
      const apiKey = process.env.GEMINI_API_KEY!;
      const filePath = videoPath || lastVideoFile;

      if (!filePath) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: "No video available. Run assrt_test first to record a test session, or provide a videoPath." }),
          }],
          isError: true,
        };
      }

      let videoBuffer: Buffer;
      try {
        videoBuffer = readFileSync(filePath);
      } catch {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ error: `Could not read video file: ${filePath}` }),
          }],
          isError: true,
        };
      }

      const videoBase64 = videoBuffer.toString("base64");
      const { GoogleGenAI } = await import("@google/genai");
      const genai = new GoogleGenAI({ apiKey });

      try {
        const response = await genai.models.generateContent({
          model: GEMINI_VIDEO_MODEL,
          contents: [
            {
              role: "user",
              parts: [
                {
                  inlineData: {
                    mimeType: "video/webm",
                    data: videoBase64,
                  },
                },
                { text: prompt },
              ],
            },
          ],
        });

        const analysis = response.text ?? "";

        trackEvent("assrt_analyze_video", {
          prompt: prompt.slice(0, 200),
          videoPath: filePath,
          source: "mcp",
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ analysis, videoPath: filePath }),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: `Gemini API error: ${err instanceof Error ? err.message : "unknown error"}`,
              videoPath: filePath,
            }),
          }],
          isError: true,
        };
      }
    }
  );
  console.error("[assrt-mcp] assrt_analyze_video tool registered (GEMINI_API_KEY found)");
} else {
  console.error("[assrt-mcp] assrt_analyze_video tool skipped (GEMINI_API_KEY not set)");
}

// ── Start ──

async function main() {
  trackEvent("mcp_server_start", { source: "mcp" }, { dedupeDaily: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[assrt-mcp] server started, waiting for JSON-RPC on stdin");

  const gracefulShutdown = async (signal: string) => {
    console.error(`[assrt-mcp] received ${signal}, cleaning up...`);
    if (sharedBrowser) {
      try {
        await sharedBrowser.close();
        console.error("[assrt-mcp] shared browser closed");
      } catch (err) {
        console.error("[assrt-mcp] error closing shared browser:", err);
      }
      sharedBrowser = null;
    }
    await shutdownTelemetry();
    process.exit(0);
  };

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("beforeExit", async () => {
    if (sharedBrowser) {
      try { await sharedBrowser.close(); } catch { /* best effort */ }
      sharedBrowser = null;
    }
  });
}

main().catch((err) => {
  console.error(`[assrt-mcp] fatal: ${err.message || err}`);
  process.exit(1);
});
