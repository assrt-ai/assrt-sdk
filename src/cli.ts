#!/usr/bin/env node
/**
 * Assrt CLI: AI-powered QA testing from the command line.
 *
 * Usage:
 *   npx assrt run --url http://localhost:3000 --plan "Test the login flow"
 *   npx assrt run --url http://localhost:3000 --plan-file tests.txt
 *   echo "Test homepage loads" | npx assrt run --url http://localhost:3000
 *   npx assrt run --url http://localhost:3000 --plan "..." --json > results.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync, copyFileSync, statSync, createReadStream } from "fs";
import { execSync } from "child_process";
import { join, basename, extname } from "path";
import { tmpdir } from "os";
import { getCredential } from "./core/keychain";
import { TestAgent } from "./core/agent";
import { McpBrowserManager } from "./core/browser";
import type { TestReport } from "./core/types";
import { trackEvent, shutdownTelemetry } from "./core/telemetry";

function printUsage(): void {
  console.error(
    "Usage:\n" +
    "  assrt setup                                    Set up MCP server, hooks, and CLAUDE.md\n" +
    "  assrt run --url <url> [options]                Run QA tests\n\n" +
    "Run options:\n" +
    "  --url         URL to test (required)\n" +
    "  --plan        Test scenarios as inline text\n" +
    "  --plan-file   Path to a file containing test scenarios\n" +
    "  --model       LLM model to use (default: claude-haiku-4-5-20251001)\n" +
    "  --headed      Launch a visible browser window (default: headless)\n" +
    "  --isolated    Keep browser profile in memory only (default: persist to ~/.assrt/browser-profile)\n" +
    "  --keep-open   Leave the browser window open after the test finishes\n" +
    "  --extension         Connect to your existing Chrome instance instead of launching a new browser\n" +
    "  --extension-token   Playwright extension token (saved automatically after first use)\n" +
    "  --video       Record a video of the test run and open the player when done\n" +
    "  --no-auto-open  Record video but don't auto-open the player\n" +
    "  --json        Output raw JSON report to stdout\n" +
    "  --help        Show this help message\n\n" +
    "Auth: Uses ANTHROPIC_API_KEY env var, or reads Claude Code credentials from macOS Keychain."
  );
}

function parseArgs(argv: string[]): {
  command: string;
  url: string;
  plan?: string;
  planFile?: string;
  model?: string;
  json: boolean;
  headed: boolean;
  isolated: boolean;
  keepBrowserOpen: boolean;
  extension: boolean;
  extensionToken?: string;
  video: boolean;
  autoOpen: boolean;
} {
  const args: Record<string, string | boolean> = {};
  const command = argv[0] || "";

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--headed") {
      args.headed = true;
      continue;
    }
    if (arg === "--isolated") {
      args.isolated = true;
      continue;
    }
    if (arg === "--keep-open") {
      args["keep-open"] = true;
      continue;
    }
    if (arg === "--extension") {
      args.extension = true;
      continue;
    }
    if (arg === "--video") {
      args.video = true;
      continue;
    }
    if (arg === "--no-auto-open") {
      args["no-auto-open"] = true;
      continue;
    }
    if (arg.startsWith("--") && i + 1 < argv.length) {
      args[arg.slice(2)] = argv[++i];
    }
  }

  return {
    command,
    url: (args.url as string) || "",
    plan: args.plan as string | undefined,
    planFile: args["plan-file"] as string | undefined,
    model: args.model as string | undefined,
    json: !!args.json,
    headed: !!args.headed || process.env.ASSRT_HEADED === "1" || process.env.ASSRT_HEADED === "true",
    isolated: !!args.isolated || process.env.ASSRT_ISOLATED === "1" || process.env.ASSRT_ISOLATED === "true",
    keepBrowserOpen: !!args["keep-open"],
    extension: !!args.extension,
    extensionToken: args["extension-token"] as string | undefined,
    video: !!args.video,
    autoOpen: !args["no-auto-open"],
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createCliEmit(jsonMode: boolean): (type: string, data: any) => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (type: string, data: any) => {
    if (jsonMode) return; // In JSON mode, only the final report goes to stdout

    switch (type) {
      case "status":
        console.error(`[status] ${data.message}`);
        break;
      case "reasoning":
        console.error(`[think] ${data.text}`);
        break;
      case "step":
        if (data.status !== "running") {
          const icon = data.status === "completed" ? "+" : "x";
          console.error(`  [${icon}] ${data.description}`);
        }
        break;
      case "assertion": {
        const icon = data.passed ? "PASS" : "FAIL";
        console.error(`  [${icon}] ${data.description}`);
        break;
      }
      case "scenario_start":
        console.error(`\n--- Scenario: ${data.name} (${data.index + 1}/${data.total}) ---`);
        break;
      case "scenario_complete": {
        const result = data.passed ? "PASSED" : "FAILED";
        console.error(`--- ${result}: ${data.name} ---`);
        break;
      }
      case "improvement_suggestion":
        console.error(`  [issue] ${data.severity}: ${data.title}`);
        break;
      case "screenshot":
      case "page_discovered":
      case "discovered_cases_chunk":
      case "discovered_cases_complete":
        // Skip in CLI mode
        break;
    }
  };
}

function printReport(report: TestReport): void {
  console.log("\n========================================");
  console.log(`  Assrt Test Report`);
  console.log("========================================");
  console.log(`  URL:      ${report.url}`);
  console.log(`  Passed:   ${report.passedCount}`);
  console.log(`  Failed:   ${report.failedCount}`);
  console.log(`  Duration: ${(report.totalDuration / 1000).toFixed(1)}s`);
  console.log("========================================\n");

  for (const scenario of report.scenarios) {
    const icon = scenario.passed ? "PASS" : "FAIL";
    console.log(`  [${icon}] ${scenario.name}`);
    if (scenario.summary) {
      console.log(`         ${scenario.summary}`);
    }
    for (const assertion of scenario.assertions) {
      const aIcon = assertion.passed ? "+" : "x";
      console.log(`    [${aIcon}] ${assertion.description}`);
    }
  }
  console.log("");
}

// ── Setup command ──

const QA_REMINDER_HOOK = `#!/bin/bash
# Assrt: Claude Code PostToolUse reminder — fires after any Bash tool use,
# injects a QA-testing reminder when the command was a git commit/push.
# NOT a git post-commit hook.
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if echo "$COMMAND" | grep -qE 'git (commit|push)'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A git commit/push was just made. If the committed changes affect anything user-facing (UI, routes, forms, APIs), run assrt_test against the local dev server to verify the changes work in a real browser. Use assrt_plan first if you need test cases."}}'
fi
`;

function setupAssrt(): void {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  console.error("[assrt] Setting up Assrt globally...\n");

  // 1. Register MCP server globally (--scope user)
  console.error("[1/3] Registering MCP server (global)...");
  try {
    execSync("which claude", { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    try {
      const mcpConfig = JSON.stringify({
        type: "stdio",
        command: "npx",
        args: ["-y", "-p", "@assrt-ai/assrt", "assrt-mcp"],
      });
      execSync(`claude mcp add-json assrt '${mcpConfig}' --scope user`, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      console.error("      Done: MCP server registered globally\n");
    } catch {
      console.error("      Skipped: MCP server already registered\n");
    }
  } catch {
    console.error("      Skipped: 'claude' CLI not found in PATH\n");
  }

  // 2. Install PostToolUse QA reminder hook globally
  console.error("[2/3] Installing QA reminder hook (global)...");
  const hookDir = join(home, ".claude", "hooks");
  const hookPath = join(hookDir, "assrt-qa-reminder.sh");
  const oldHookPath = join(hookDir, "assrt-post-commit.sh");
  if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });
  writeFileSync(hookPath, QA_REMINDER_HOOK, { mode: 0o755 });

  // Migrate: remove legacy hook file if it exists
  if (existsSync(oldHookPath)) {
    try { unlinkSync(oldHookPath); } catch { /* best effort */ }
  }

  // Add hook to global settings
  const settingsPath = join(home, ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = (settings.hooks || {}) as Record<string, any>;
  let postToolUse = (hooks.PostToolUse || []) as Array<Record<string, unknown>>;

  // Migrate: drop any existing entries that reference the legacy hook name
  const hadLegacy = postToolUse.some((h) => JSON.stringify(h).includes("assrt-post-commit"));
  if (hadLegacy) {
    postToolUse = postToolUse.filter((h) => !JSON.stringify(h).includes("assrt-post-commit"));
  }

  const alreadyInstalled = postToolUse.some(
    (h) => JSON.stringify(h).includes("assrt-qa-reminder")
  );
  if (!alreadyInstalled) {
    postToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: hookPath }],
    });
  }
  hooks.PostToolUse = postToolUse;
  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  if (hadLegacy) {
    console.error(`      Done: migrated legacy hook, installed at ${hookPath}\n`);
  } else if (alreadyInstalled) {
    console.error("      Skipped: hook already installed\n");
  } else {
    console.error(`      Done: hook installed at ${hookPath}\n`);
  }

  // 3. Append to global CLAUDE.md if not already present
  console.error("[3/3] Updating global CLAUDE.md...");
  const claudeMdPath = join(home, ".claude", "CLAUDE.md");
  let claudeMd = "";
  if (existsSync(claudeMdPath)) {
    claudeMd = readFileSync(claudeMdPath, "utf-8");
  }
  if (!claudeMd.includes("assrt_test") && !claudeMd.includes("## QA Testing")) {
    const snippet = `\n\n## QA Testing (Assrt)\n\n**CRITICAL: You MUST run \`assrt_test\` after ANY user-facing change.** Do not wait for the user to ask. Do not skip this step. Do not consider a task complete until tests pass.\n\n- **After every UI, route, form, or user flow change**: run \`assrt_test\` against the local dev server to verify it works in a real browser.\n- **New features**: use \`assrt_plan\` to auto-generate test cases, then run them with \`assrt_test\`.\n- **Bug fixes**: write a targeted \`#Case\` that reproduces the bug, run with \`assrt_test\`.\n- **Failed tests**: use \`assrt_diagnose\` to understand root cause before attempting a fix. Do not guess.\n- **Video playback**: \`assrt_test\` records a video of each test run and auto-opens a player in the browser by default (\`autoOpenPlayer: true\`). If the user prefers not to have the video player open automatically, set \`autoOpenPlayer: false\` in subsequent calls.\n- **Non-blocking tests**: To avoid blocking the conversation, run tests via the CLI with the Bash tool's \`run_in_background\` option: \`npx assrt run --url <url> --plan "..." --video --json\`. The JSON output includes \`videoPlayerUrl\` when \`--video\` is used.\n`;
    writeFileSync(claudeMdPath, claudeMd + snippet);
    console.error("      Done: added QA testing section to global CLAUDE.md\n");
  } else {
    console.error("      Skipped: CLAUDE.md already has Assrt instructions\n");
  }

  console.error("[assrt] Setup complete! Restart Claude Code to activate.\n");
  console.error("  MCP tools available globally: assrt_test, assrt_plan, assrt_diagnose");
  console.error("  QA reminder hook: will suggest testing after git commit/push");
  console.error("  Global CLAUDE.md: instructs the agent to test proactively\n");
}

// ── Video player HTML generator ──

function generateVideoPlayerHtml(videoFilename: string, url: string, passed: number, failed: number, durationSec: number): string {
  const status = failed === 0 ? "PASSED" : "FAILED";
  const color = failed === 0 ? "#22c55e" : "#ef4444";
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Assrt Test Recording</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}body{background:#0a0a0a;color:#e5e5e5;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px}
h1{font-size:18px;margin-bottom:8px}
.meta{font-size:13px;color:#a3a3a3;margin-bottom:16px}
.meta .status{color:${color};font-weight:700}
video{max-width:95vw;max-height:75vh;border-radius:8px;background:#000}
.controls{margin-top:12px;display:flex;gap:8px}
.controls button{background:#262626;color:#e5e5e5;border:1px solid #404040;border-radius:6px;padding:6px 14px;cursor:pointer;font-size:13px}
.controls button:hover{background:#404040}
.controls button.active{background:#3b82f6;border-color:#3b82f6}
</style></head><body>
<h1>Assrt Test Recording</h1>
<p class="meta"><span class="status">${status}</span> | ${passed} passed, ${failed} failed | ${durationSec}s | ${url}</p>
<video src="${videoFilename}" controls autoplay></video>
<div class="controls">
<button data-speed="1" class="active">1x</button>
<button data-speed="2">2x</button>
<button data-speed="3">3x</button>
<button data-speed="5">5x</button>
<button data-speed="10">10x</button>
</div>
<script>
const v=document.querySelector('video'),btns=document.querySelectorAll('.controls button');
function setSpeed(s){v.playbackRate=s;btns.forEach(b=>b.classList.toggle('active',+b.dataset.speed===s));}
btns.forEach(b => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
document.addEventListener('keydown', e => {
  if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
  if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); }
  if (e.key === 'ArrowRight') { v.currentTime += 5; }
  const speedMap = { '1': 1, '2': 2, '3': 3, '5': 5, '0': 10 };
  if (speedMap[e.key]) setSpeed(speedMap[e.key]);
});
</script></body></html>`;
}

// ── Video server (serves player + video with Range support for seeking) ──

async function startVideoServer(videoDir: string): Promise<number> {
  const http = await import("http");
  const mime: Record<string, string> = { ".html": "text/html", ".webm": "video/webm", ".mp4": "video/mp4" };

  const srv = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/player.html") {
      try {
        const playerPath = join(videoDir, "player.html");
        const data = readFileSync(playerPath, "utf-8");
        const videoFiles = readdirSync(videoDir).filter((f: string) => f.endsWith(".webm"));
        const rewritten = videoFiles.length > 0
          ? data.replace(`src="${videoFiles[0]}"`, `src="/video/${encodeURIComponent(videoFiles[0])}"`)
          : data;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(rewritten);
      } catch {
        res.writeHead(404);
        res.end("Player not found");
      }
      return;
    }

    if (url.pathname.startsWith("/video/")) {
      const filename = decodeURIComponent(url.pathname.slice("/video/".length));
      const filePath = join(videoDir, basename(filename));
      const ext = extname(filePath).toLowerCase();
      const contentType = mime[ext] || "application/octet-stream";

      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(filePath);
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
          createReadStream(filePath, { start, end: clampedEnd }).pipe(res);
          return;
        }
      }

      res.writeHead(200, { "Content-Length": stat.size, "Content-Type": contentType, "Accept-Ranges": "bytes" });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  return new Promise<number>((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      console.error(`[assrt] Video player server started on port ${port}`);
      resolve(port);
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "setup") {
    setupAssrt();
    await trackEvent("assrt_setup", { source: "cli" });
    await shutdownTelemetry();
    return;
  }

  if (args.command !== "run") {
    printUsage();
    process.exit(args.command === "" ? 1 : 1);
  }

  if (!args.url) {
    console.error("Error: --url is required\n");
    printUsage();
    process.exit(1);
  }

  // Get credential (Keychain OAuth token or env var API key)
  let credential: ReturnType<typeof getCredential>;
  try {
    credential = getCredential();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }

  // Get test plan
  let plan = "";
  if (args.planFile) {
    try {
      plan = readFileSync(args.planFile, "utf-8").trim();
    } catch (err) {
      console.error(`Error reading plan file: ${(err as Error).message}`);
      process.exit(1);
    }
  } else if (args.plan) {
    plan = args.plan;
  } else {
    plan = await readStdin();
  }

  if (!plan) {
    console.error("Error: provide test scenarios via --plan, --plan-file, or stdin\n");
    printUsage();
    process.exit(1);
  }

  const emit = createCliEmit(args.json);

  if (!args.json) {
    console.error(`[assrt] Testing ${args.url}`);
    console.error(`[assrt] Model: ${args.model || "default"}`);
  }

  const t0 = Date.now();

  // Set up video recording if requested
  const videoDir = args.video ? join(tmpdir(), "assrt", `cli-${Date.now()}`, "video") : undefined;
  let browser: McpBrowserManager | undefined;
  let videoFilesBefore: string[] = [];

  if (videoDir) {
    mkdirSync(videoDir, { recursive: true });
    browser = new McpBrowserManager();
    // Pre-launch browser so we can start video before the test
    await browser.launchLocal(videoDir, args.headed, args.isolated, args.extension, args.extensionToken);
    const playwrightOutputDir = browser.getOutputDir();
    if (playwrightOutputDir) {
      try { videoFilesBefore = readdirSync(playwrightOutputDir).filter((f) => f.endsWith(".webm")); } catch { /* */ }
    }
    await browser.startVideo();
    if (!args.json) console.error("[assrt] Video recording started");
  }

  const agent = new TestAgent(credential.token, emit, args.model, "anthropic", null, "local", credential.type, videoDir, args.headed, args.isolated, browser, args.extension, args.extensionToken);
  const report = await agent.run(args.url, plan);

  // Stop video and collect the recording
  let videoPlayerUrl: string | null = null;
  if (videoDir && browser) {
    await browser.stopVideo();
    if (!args.json) console.error("[assrt] Video recording stopped");

    // Copy video file from Playwright output dir to our video dir
    const playwrightOutputDir = browser.getOutputDir();
    if (playwrightOutputDir) {
      try {
        const videoFilesAfter = readdirSync(playwrightOutputDir).filter((f) => f.endsWith(".webm"));
        const newVideoFiles = videoFilesAfter.filter((f) => !videoFilesBefore.includes(f));
        if (newVideoFiles.length > 0) {
          const srcPath = join(playwrightOutputDir, newVideoFiles[0]);
          const destPath = join(videoDir, "recording.webm");
          copyFileSync(srcPath, destPath);
          if (!args.json) console.error(`[assrt] Video saved: ${destPath}`);
        }
      } catch (err) {
        console.error(`[assrt] Video copy failed: ${(err as Error).message}`);
      }
    }

    // Generate player HTML and serve it
    try {
      const videoFiles = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
      if (videoFiles.length > 0) {
        const playerPath = join(videoDir, "player.html");
        writeFileSync(playerPath, generateVideoPlayerHtml(
          videoFiles[0],
          args.url,
          report.passedCount,
          report.failedCount,
          +(report.totalDuration / 1000).toFixed(1),
        ));

        const port = await startVideoServer(videoDir);
        videoPlayerUrl = `http://127.0.0.1:${port}/player.html`;

        if (args.autoOpen) {
          try { execSync(`open "${videoPlayerUrl}"`); } catch { /* best effort */ }
          if (!args.json) console.error(`[assrt] Video player opened: ${videoPlayerUrl}`);
        } else {
          if (!args.json) console.error(`[assrt] Video player available at: ${videoPlayerUrl}`);
        }
      }
    } catch { /* no video files */ }
  }

  await agent.close({ keepBrowserOpen: args.keepBrowserOpen });

  await trackEvent("assrt_test_run", {
    url: args.url,
    model: args.model || "default",
    passed: report.failedCount === 0,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    duration_s: +((Date.now() - t0) / 1000).toFixed(1),
    scenarioCount: report.scenarios.length,
    source: "cli",
    video: args.video,
  });

  if (args.json) {
    const jsonReport = { ...report, videoPlayerUrl };
    process.stdout.write(JSON.stringify(jsonReport, null, 2) + "\n");
  } else {
    printReport(report);
    if (videoPlayerUrl) {
      console.log(`  Video:    ${videoPlayerUrl}`);
    }
  }

  await shutdownTelemetry();
  process.exit(report.failedCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`Fatal error: ${err.message || err}`);
  await shutdownTelemetry();
  process.exit(1);
});
