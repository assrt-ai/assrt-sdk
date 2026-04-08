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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { getCredential } from "./core/keychain";
import { TestAgent } from "./core/agent";
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

const POST_COMMIT_HOOK = `#!/bin/bash
# Assrt: suggest QA testing after git commit/push
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)
if echo "$COMMAND" | grep -qE 'git (commit|push)'; then
  echo '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"A git commit/push was just made. If the committed changes affect anything user-facing (UI, routes, forms, APIs), run assrt_test against the local dev server to verify the changes work in a real browser. Use assrt_plan first if you need test cases."}}'
fi
`;

function setupAssrt(): void {
  const cwd = process.env.INIT_CWD || process.cwd();
  console.error("[assrt] Setting up Assrt in this project...\n");

  // 1. Register MCP server
  console.error("[1/3] Registering MCP server...");
  try {
    // Check if claude CLI exists first
    execSync("which claude", { stdio: ["pipe", "pipe", "pipe"], timeout: 5000 });
    try {
      // Use add-json instead of `add ... --` which hangs during health check
      const mcpConfig = JSON.stringify({
        type: "stdio",
        command: "npx",
        args: ["-y", "-p", "@assrt-ai/assrt", "assrt-mcp"],
      });
      execSync(`claude mcp add-json assrt '${mcpConfig}'`, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 15000,
      });
      console.error("      Done: MCP server registered\n");
    } catch {
      console.error("      Skipped: MCP server already registered\n");
    }
  } catch {
    console.error("      Skipped: 'claude' CLI not found in PATH\n");
  }

  // 2. Install PostToolUse hook
  console.error("[2/3] Installing post-commit hook...");
  const hookDir = join(cwd, ".claude", "hooks");
  const hookPath = join(hookDir, "assrt-post-commit.sh");
  if (!existsSync(hookDir)) mkdirSync(hookDir, { recursive: true });
  writeFileSync(hookPath, POST_COMMIT_HOOK, { mode: 0o755 });

  // Add hook to project settings
  const settingsDir = join(cwd, ".claude");
  const settingsPath = join(settingsDir, "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch { /* */ }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hooks = (settings.hooks || {}) as Record<string, any>;
  const postToolUse = (hooks.PostToolUse || []) as Array<Record<string, unknown>>;

  // Check if hook already exists
  const alreadyInstalled = postToolUse.some(
    (h) => JSON.stringify(h).includes("assrt-post-commit")
  );
  if (!alreadyInstalled) {
    postToolUse.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: hookPath }],
    });
    hooks.PostToolUse = postToolUse;
    settings.hooks = hooks;
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.error(`      Done: hook installed at ${hookPath}\n`);
  } else {
    console.error("      Skipped: hook already installed\n");
  }

  // 3. Append to CLAUDE.md if not already present
  console.error("[3/3] Updating CLAUDE.md...");
  const claudeMdPath = join(cwd, "CLAUDE.md");
  let claudeMd = "";
  if (existsSync(claudeMdPath)) {
    claudeMd = readFileSync(claudeMdPath, "utf-8");
  }
  if (!claudeMd.includes("assrt_test") && !claudeMd.includes("## QA Testing")) {
    const snippet = `\n\n## QA Testing (Assrt)\n\n**CRITICAL: You MUST run \`assrt_test\` after ANY user-facing change.** Do not wait for the user to ask. Do not skip this step. Do not consider a task complete until tests pass.\n\n- **After every UI, route, form, or user flow change**: run \`assrt_test\` against the local dev server to verify it works in a real browser.\n- **New features**: use \`assrt_plan\` to auto-generate test cases, then run them with \`assrt_test\`.\n- **Bug fixes**: write a targeted \`#Case\` that reproduces the bug, run with \`assrt_test\`.\n- **Failed tests**: use \`assrt_diagnose\` to understand root cause before attempting a fix. Do not guess.\n- **Video playback**: \`assrt_test\` records a video of each test run and auto-opens a player in the browser by default (\`autoOpenPlayer: true\`). If the user prefers not to have the video player open automatically, set \`autoOpenPlayer: false\` in subsequent calls.\n`;
    writeFileSync(claudeMdPath, claudeMd + snippet);
    console.error("      Done: added QA testing section to CLAUDE.md\n");
  } else {
    console.error("      Skipped: CLAUDE.md already has Assrt instructions\n");
  }

  console.error("[assrt] Setup complete! Restart Claude Code to activate.\n");
  console.error("  MCP tools available: assrt_test, assrt_plan, assrt_diagnose");
  console.error("  Post-commit hook: will suggest testing after git commit/push");
  console.error("  CLAUDE.md: instructs the agent to test proactively\n");
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
  const agent = new TestAgent(credential.token, emit, args.model, "anthropic", null, "local", credential.type);
  const report = await agent.run(args.url, plan);

  await trackEvent("assrt_test_run", {
    url: args.url,
    model: args.model || "default",
    passed: report.failedCount === 0,
    passedCount: report.passedCount,
    failedCount: report.failedCount,
    duration_s: +((Date.now() - t0) / 1000).toFixed(1),
    scenarioCount: report.scenarios.length,
    source: "cli",
  });

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printReport(report);
  }

  await shutdownTelemetry();
  process.exit(report.failedCount > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`Fatal error: ${err.message || err}`);
  await shutdownTelemetry();
  process.exit(1);
});
