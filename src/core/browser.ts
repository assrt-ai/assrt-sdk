/**
 * MCP Browser Manager — manages a local Playwright MCP server over stdio.
 *
 * Launch modes:
 *   - launchLocal(): spawns a local Playwright MCP process (headless, headed, or extension)
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

/** Thrown when extension mode is requested but no token is available. */
export class ExtensionTokenRequired extends Error {
  constructor() {
    super(
      "Extension mode requires a one-time setup token.\n\n" +
      "To set it up:\n" +
      "1. Make sure Chrome is running with the Playwright MCP extension installed\n" +
      "   (install from: https://chromewebstore.google.com/detail/playwright-mcp-bridge/gjloebkfhhlbhemfgnmpjafamelkidba)\n" +
      "2. Run this command in your terminal:\n" +
      "   npx @playwright/mcp@latest --extension\n" +
      "3. Approve the connection in the Chrome dialog that appears\n" +
      "4. Copy the token shown (PLAYWRIGHT_MCP_EXTENSION_TOKEN=...)\n" +
      "5. Paste the token value here so I can save it for future use"
    );
    this.name = "ExtensionTokenRequired";
  }
}

/* ── Injected script for visual cursor + keystroke overlay ──
 * Runs inside the remote browser page. Creates DOM overlays that appear
 * in CDP screencast frames: a red cursor dot, click ripple, keystroke
 * toast, and a heartbeat pulse that forces continuous compositor frames. */
const CURSOR_INJECT_SCRIPT = `
if (!window.__pias_cursor_injected) {
  window.__pias_cursor_injected = true;

  const heartbeat = document.createElement('div');
  heartbeat.id = '__pias_heartbeat';
  Object.assign(heartbeat.style, {
    position: 'fixed', bottom: '8px', right: '8px', width: '6px', height: '6px',
    borderRadius: '50%', background: 'rgba(34,197,94,0.6)', zIndex: '2147483647',
    pointerEvents: 'none',
  });
  heartbeat.animate(
    [{ opacity: 0.2, transform: 'scale(0.8)' }, { opacity: 0.8, transform: 'scale(1.2)' }],
    { duration: 800, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }
  );
  document.body.appendChild(heartbeat);

  const cursor = document.createElement('div');
  cursor.id = '__pias_cursor';
  Object.assign(cursor.style, {
    position: 'fixed', width: '20px', height: '20px', borderRadius: '50%',
    background: 'rgba(239,68,68,0.85)', border: '2px solid white',
    boxShadow: '0 0 8px rgba(239,68,68,0.5)', zIndex: '2147483647',
    pointerEvents: 'none', transition: 'left 0.3s ease, top 0.3s ease',
    left: '-40px', top: '-40px', transform: 'translate(-50%,-50%)',
  });
  document.body.appendChild(cursor);

  const ripple = document.createElement('div');
  ripple.id = '__pias_ripple';
  Object.assign(ripple.style, {
    position: 'fixed', width: '40px', height: '40px', borderRadius: '50%',
    border: '2px solid rgba(239,68,68,0.6)', zIndex: '2147483646',
    pointerEvents: 'none', opacity: '0', transform: 'translate(-50%,-50%) scale(0.5)',
    left: '-40px', top: '-40px',
  });
  document.body.appendChild(ripple);

  const toast = document.createElement('div');
  toast.id = '__pias_toast';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
    background: 'rgba(0,0,0,0.85)', color: '#22c55e', padding: '8px 16px',
    borderRadius: '8px', fontFamily: 'monospace', fontSize: '14px',
    zIndex: '2147483647', pointerEvents: 'none', opacity: '0',
    transition: 'opacity 0.2s', maxWidth: '80%', whiteSpace: 'nowrap',
    overflow: 'hidden', textOverflow: 'ellipsis', border: '1px solid rgba(34,197,94,0.3)',
  });
  document.body.appendChild(toast);

  window.__pias_moveCursor = (x, y) => {
    cursor.style.left = x + 'px'; cursor.style.top = y + 'px';
  };
  window.__pias_showClick = (x, y) => {
    cursor.style.left = x + 'px'; cursor.style.top = y + 'px';
    ripple.style.left = x + 'px'; ripple.style.top = y + 'px';
    ripple.style.opacity = '1'; ripple.style.transform = 'translate(-50%,-50%) scale(0.5)';
    setTimeout(() => { ripple.style.transform = 'translate(-50%,-50%) scale(2)'; ripple.style.opacity = '0'; }, 50);
  };
  window.__pias_showToast = (msg) => {
    toast.textContent = msg; toast.style.opacity = '1';
    clearTimeout(window.__pias_toastTimer);
    window.__pias_toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
  };
}
`;

export class McpBrowserManager {
  private client: Client = null;

  /** Whether the MCP client reference exists (does NOT guarantee the browser is alive). */
  get isConnected(): boolean {
    return this.client != null;
  }

  /**
   * Perform a real health check by sending a lightweight tool call with a short timeout.
   * Returns true if the browser is alive and responding, false otherwise.
   */
  async isAlive(): Promise<boolean> {
    if (!this.client) return false;
    try {
      await this.client.callTool(
        { name: "browser_snapshot", arguments: {} },
        undefined,
        { timeout: 5000 }
      );
      return true;
    } catch {
      console.error("[browser] health check failed, browser is dead");
      return false;
    }
  }

  // Track cursor position server-side so it persists across navigations
  private cursorX = 640;  // Start roughly center-screen
  private cursorY = 400;

  /** Directory where Playwright saves the video recording (set by launchLocal). */
  videoDir: string | null = null;
  /** Directory where Playwright MCP writes snapshot files in file output mode. */
  private outputDir: string | null = null;
  /** Get the Playwright MCP output directory path. */
  getOutputDir(): string | null { return this.outputDir; }

  /** The stdio transport for the local Playwright MCP process. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private transport: any = null;

  /**
   * Kill any orphan Chrome/Playwright processes that are using a given user-data-dir.
   * This prevents multiple Chrome instances from fighting over the same profile
   * when a previous assrt session crashed or timed out without cleanup.
   */
  static async killOrphanChromeProcesses(userDataDir: string): Promise<void> {
    try {
      const { execSync } = await import("child_process");
      // Find all Chrome processes using this specific user-data-dir
      const psOutput = execSync(
        `ps aux | grep -E "user-data-dir.*${userDataDir.replace(/\//g, "\\/")}" | grep -v grep || true`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      if (!psOutput) return;

      const pids: number[] = [];
      for (const line of psOutput.split("\n")) {
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[1], 10);
        if (pid && !isNaN(pid)) pids.push(pid);
      }

      if (pids.length === 0) return;

      console.error(`[browser] found ${pids.length} orphan Chrome process(es) using ${userDataDir}: ${pids.join(", ")}`);

      // Also find any Playwright MCP parent processes that spawned these Chrome instances
      for (const chromePid of [...pids]) {
        try {
          const ppidOut = execSync(`ps -o ppid= -p ${chromePid}`, { encoding: "utf-8", timeout: 3000 }).trim();
          const ppid = parseInt(ppidOut, 10);
          if (ppid && !isNaN(ppid) && ppid > 1) {
            // Check if the parent is a playwright-mcp process
            const parentCmd = execSync(`ps -o command= -p ${ppid}`, { encoding: "utf-8", timeout: 3000 }).trim();
            if (parentCmd.includes("playwright") && !pids.includes(ppid)) {
              pids.push(ppid);
              console.error(`[browser] also killing Playwright MCP parent (pid=${ppid})`);
            }
          }
        } catch { /* parent may already be gone */ }
      }

      // Kill all orphan processes
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGKILL");
          console.error(`[browser] killed orphan process pid=${pid}`);
        } catch { /* already dead */ }
      }

      // Brief pause to let OS release file locks
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.error(`[browser] orphan cleanup error (non-fatal):`, err);
    }
  }

  /** Launch browser locally via Playwright MCP over stdio (CLI mode).
   *  @param videoDir — Optional directory for Playwright video recording. If provided, a config
   *  file is written with recordVideo enabled and passed to the MCP server via --config.
   *  @param headed — When true, launch a visible browser window. Defaults to headless.
   *  @param isolated — When true, keep browser profile in memory only (no disk persistence).
   *  When false (default), persist the browser profile to ~/.assrt/browser-profile so cookies,
   *  localStorage, and logins survive across test runs. */
  /** Saved extension token file path. */
  private static readonly EXTENSION_TOKEN_PATH = ".assrt/extension-token";

  /** Resolve the extension token from (in priority order): parameter, env var, saved file.
   *  Returns null if none found. Saves new tokens to disk for future use. */
  private async resolveExtensionToken(tokenParam?: string): Promise<string | null> {
    const { homedir } = await import("os");
    const { join } = await import("path");
    const tokenPath = join(homedir(), McpBrowserManager.EXTENSION_TOKEN_PATH);

    // 1. Explicit parameter (highest priority)
    if (tokenParam) {
      // Save for future use
      const { mkdirSync, writeFileSync } = await import("fs");
      mkdirSync(join(homedir(), ".assrt"), { recursive: true });
      writeFileSync(tokenPath, tokenParam.trim());
      console.error("[browser] extension token saved to ~/.assrt/extension-token");
      return tokenParam.trim();
    }

    // 2. Environment variable
    const envToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    if (envToken) return envToken.trim();

    // 3. Saved file
    try {
      const { readFileSync } = await import("fs");
      const saved = readFileSync(tokenPath, "utf-8").trim();
      if (saved) return saved;
    } catch { /* file doesn't exist */ }

    return null;
  }

  /** @returns true if an existing browser was reused, false if a new one was launched. */
  async launchLocal(videoDir?: string, headed?: boolean, isolated?: boolean, extension?: boolean, extensionToken?: string): Promise<boolean> {
    // Reuse existing browser connection if still alive
    if (this.client) {
      console.error("[browser] reusing existing browser connection");
      // Update videoDir for this run if provided
      if (videoDir) this.videoDir = videoDir;
      return true;
    }

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );

    // cli.js isn't in package exports; resolve the package dir at runtime
    const { dirname, join } = await import("path");
    const { tmpdir, homedir } = await import("os");
    const { createRequire } = await import("module");
    const require_ = createRequire(import.meta.url);
    const pkgDir = dirname(require_.resolve("@playwright/mcp/package.json"));
    const cliPath = join(pkgDir, "cli.js");
    console.error("[browser] spawning local Playwright MCP via stdio");
    const tConn = Date.now();

    // Output snapshots to files to avoid blowing up the MCP transport with huge
    // accessibility trees (e.g. Wikipedia). The agent reads truncated content.
    const outputDir = join(homedir(), ".assrt", "playwright-output");
    const { mkdirSync } = await import("fs");
    mkdirSync(outputDir, { recursive: true });
    this.outputDir = outputDir;

    const args = [cliPath, "--viewport-size", "1600x900", "--output-mode", "file", "--output-dir", outputDir, "--caps", "devtools"];
    // Extension token resolution (needed before spawning)
    let resolvedExtensionToken: string | null = null;
    if (extension) {
      resolvedExtensionToken = await this.resolveExtensionToken(extensionToken);
      if (!resolvedExtensionToken) {
        throw new ExtensionTokenRequired();
      }
      // Extension mode connects to an existing Chrome; skip profile/headless flags
      args.push("--extension");
      console.error("[browser] launch mode: extension (connecting to existing Chrome)");
    } else if (isolated) {
      args.push("--isolated");
      console.error("[browser] profile mode: isolated (in-memory, no persistence)");
    } else {
      const { lstatSync, unlinkSync, readlinkSync, writeFileSync } = await import("fs");
      const { execSync } = await import("child_process");
      const userDataDir = join(homedir(), ".assrt", "browser-profile");
      mkdirSync(userDataDir, { recursive: true });

      // Kill any orphan Chrome processes using this profile before launching.
      // Without this, removing SingletonLock while Chrome is still running causes
      // multiple Chrome instances to fight over the same user-data-dir.
      await McpBrowserManager.killOrphanChromeProcesses(userDataDir);

      // Clean up Chromium singleton/lock files that block concurrent profile access.
      // SingletonLock is a symlink (target: "hostname-PID"), so we must use lstatSync
      // (existsSync follows symlinks and returns false for the broken target path).
      // Also clean SingletonSocket and SingletonCookie which can cause "Opening in
      // existing browser session" errors when a previous browser exited uncleanly.
      const singletonFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
      for (const name of singletonFiles) {
        const lockPath = join(userDataDir, name);
        let hasLock = false;
        try { lstatSync(lockPath); hasLock = true; } catch { /* no lock */ }
        if (hasLock) {
          try {
            unlinkSync(lockPath);
            console.error(`[browser] removed stale ${name} from browser profile`);
          } catch {
            console.error(`[browser] could not remove ${name}, falling back to isolated mode`);
            args.push("--isolated");
            isolated = true;
            break;
          }
        }
      }
      if (!isolated) {
        args.push("--user-data-dir", userDataDir);
        console.error(`[browser] profile mode: persistent (${userDataDir})`);
      }
    }
    if (!extension) {
      if (!headed) args.splice(1, 0, "--headless");
      console.error(`[browser] launch mode: ${headed ? "headed" : "headless"}`);
    }

    // Video recording is now managed per-run via startVideo/stopVideo (devtools capability)
    // instead of context-level recordVideo config, so it works with persistent browser sessions.
    if (videoDir) {
      this.videoDir = videoDir;
    }

    const transportEnv = resolvedExtensionToken
      ? { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: resolvedExtensionToken }
      : undefined;
    this.transport = new StdioClientTransport({
      command: process.execPath,
      args,
      stderr: "pipe",
      ...(transportEnv && { env: transportEnv }),
    });

    this.client = new Client(
      { name: "assrt", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(this.transport);
    console.error(
      `[browser] local MCP connected in ${((Date.now() - tConn) / 1000).toFixed(1)}s`
    );
    return false;
  }

  /** Per-call timeout for MCP tool requests (overrides the SDK's 60s default). */
  private static readonly TOOL_TIMEOUT_MS = 120_000;

  /** Call a Playwright MCP tool by name.
   *  Uses a 120s timeout (vs the SDK's 60s default) to give slow navigations room,
   *  and detects connection failures so callers can trigger reconnection. */
  private async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResult> {
    if (!this.client) throw new Error("MCP client not connected");
    const t = Date.now();
    const argSummary =
      name === "browser_navigate"
        ? ` url=${(args as { url?: string }).url}`
        : name === "browser_type"
          ? ` text=${JSON.stringify((args as { text?: string }).text).slice(0, 40)}`
          : name === "browser_click"
            ? ` el=${JSON.stringify((args as { element?: string }).element).slice(0, 40)}`
            : "";
    try {
      const result = (await this.client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: McpBrowserManager.TOOL_TIMEOUT_MS }
      )) as McpToolResult;
      const dt = Date.now() - t;
      const err = result.isError ? " ERROR" : "";
      console.error(`[mcp] ${name}${argSummary} (${dt}ms)${err}`);
      return result;
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const dt = Date.now() - t;
      console.error(`[mcp] ${name}${argSummary} THREW after ${dt}ms: ${msg}`);
      // Mark the client as dead on timeout or transport errors so isConnected reflects reality
      if (msg.includes("Request timed out") || msg.includes("-32001") || msg.includes("EPIPE") || msg.includes("not connected")) {
        console.error("[browser] marking client as dead after transport/timeout error");
        this.client = null;
        this.transport = null;
      }
      throw e;
    }
  }

  // ── Visual overlay helpers ──

  /** Inject cursor + toast overlays into the page (safe to call multiple times).
   *  After injection, restores cursor to its last known position instantly
   *  (no transition) so it doesn't animate from off-screen. */
  private async injectOverlay(): Promise<void> {
    try {
      await this.callTool("browser_evaluate", {
        "function": `() => {
          ${CURSOR_INJECT_SCRIPT}
          // Restore cursor to last known position without animation
          const c = document.getElementById('__pias_cursor');
          if (c) {
            c.style.transition = 'none';
            c.style.left = '${this.cursorX}px';
            c.style.top = '${this.cursorY}px';
            // Re-enable smooth transition after a tick
            setTimeout(() => { c.style.transition = 'left 0.3s ease, top 0.3s ease'; }, 50);
          }
        }`,
      });
    } catch { /* page might be navigating */ }
  }

  /** Move cursor smoothly to an element and show click ripple.
   *  The cursor glides from its previous position via CSS transition.
   *  Updates the tracked position so it persists across navigations. */
  private async showClickAt(element: string, ref?: string): Promise<void> {
    try {
      await this.injectOverlay();
      const sel = JSON.stringify(element);
      const result = await this.callTool("browser_evaluate", {
        "function": `() => {
          const sel = ${sel};
          const selLower = sel.toLowerCase();
          let el = null;
          try { el = document.querySelector(sel); } catch {}
          if (!el) {
            const candidates = document.querySelectorAll('a, button, input, [role="button"], select, textarea, label, [onclick], [href]');
            const words = selLower.split(/\\s+/).filter(w => w.length > 2);
            let bestScore = 0;
            for (const e of candidates) {
              const txt = (e.textContent || '').trim().toLowerCase();
              if (!txt) continue;
              if (txt === selLower) { el = e; break; }
              let score = 0;
              if (txt.includes(selLower)) score = 3;
              else if (selLower.includes(txt) && txt.length > 2) score = 2;
              else {
                const matched = words.filter(w => txt.includes(w)).length;
                if (matched > 0) score = matched / words.length;
              }
              if (score > bestScore) { bestScore = score; el = e; }
            }
          }
          if (el) {
            const r = el.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            window.__pias_showClick?.(x, y);
            return JSON.stringify({ x, y });
          }
          return null;
        }`,
      });
      // Update tracked cursor position from the result
      const text = extractText(result);
      if (text) {
        try {
          const parsed = JSON.parse(text.replace(/^.*?(\{.*\}).*$/, "$1"));
          if (parsed && typeof parsed.x === "number") {
            this.cursorX = Math.round(parsed.x);
            this.cursorY = Math.round(parsed.y);
          }
        } catch { /* parse failed, keep old position */ }
      }
    } catch { /* element might not exist yet */ }
  }

  /** Show a keystroke toast at the bottom of the page. */
  private async showKeystroke(label: string): Promise<void> {
    try {
      await this.injectOverlay();
      await this.callTool("browser_evaluate", {
        "function": `() => { window.__pias_showToast?.(${JSON.stringify(label)}); }`,
      });
    } catch { /* */ }
  }

  // ── Convenience methods mapping to Playwright MCP tools ──

  async navigate(url: string): Promise<string> {
    const result = await this.callTool("browser_navigate", { url });
    // Re-inject overlay after navigation (new page clears DOM)
    await this.injectOverlay();
    return this.resolveAndTruncate(extractText(result));
  }

  /** Max characters for a snapshot before truncation (roughly ~30k tokens). */
  private static readonly SNAPSHOT_MAX_CHARS = 120_000;

  /**
   * Resolve file references in Playwright MCP output (file output mode) and
   * truncate large snapshots to avoid blowing up the agent's context window.
   */
  private async resolveAndTruncate(text: string): Promise<string> {
    // In file output mode, Playwright MCP returns a reference to a .yml file.
    // Read the file content so the agent has the actual accessibility tree.
    if (this.outputDir && text.includes(".yml")) {
      const match = text.match(/([^\s"]+\.yml)/);
      if (match) {
        const filePath = match[1];
        const { readFileSync } = await import("fs");
        const { resolve } = await import("path");
        const fullPath = filePath.startsWith("/") ? filePath : resolve(this.outputDir, filePath);
        try {
          text = readFileSync(fullPath, "utf-8");
        } catch {
          // Fall back to whatever text the MCP returned
        }
      }
    }

    // Truncate massive snapshots (e.g. Wikipedia) to prevent context overflow
    if (text.length > McpBrowserManager.SNAPSHOT_MAX_CHARS) {
      const originalLen = text.length;
      const truncated = text.slice(0, McpBrowserManager.SNAPSHOT_MAX_CHARS);
      const lineBreak = truncated.lastIndexOf("\n");
      text = (lineBreak > 0 ? truncated.slice(0, lineBreak) : truncated)
        + `\n\n[Snapshot truncated: showing ${(McpBrowserManager.SNAPSHOT_MAX_CHARS / 1000).toFixed(0)}k of ${(originalLen / 1000).toFixed(0)}k chars. Use element refs visible above to interact.]`;
      console.error(`[browser] snapshot truncated: ${McpBrowserManager.SNAPSHOT_MAX_CHARS} chars (original: ${originalLen})`);
    }

    return text;
  }

  async snapshot(): Promise<string> {
    const result = await this.callTool("browser_snapshot");
    return this.resolveAndTruncate(extractText(result));
  }

  async click(element: string, ref?: string): Promise<string> {
    await this.showClickAt(element, ref);
    // Wait for the cursor to glide to the target (0.3s CSS transition + ripple)
    await new Promise((r) => setTimeout(r, 400));
    const args: Record<string, unknown> = { element };
    if (ref) args.ref = ref;
    const result = await this.callTool("browser_click", args);
    return this.resolveAndTruncate(extractText(result));
  }

  async type(element: string, text: string, ref?: string): Promise<string> {
    await this.showClickAt(element, ref);
    await new Promise((r) => setTimeout(r, 400));
    await this.showKeystroke(`⌨ typing: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
    const args: Record<string, unknown> = { element, text };
    if (ref) args.ref = ref;
    const result = await this.callTool("browser_type", args);
    return this.resolveAndTruncate(extractText(result));
  }

  async selectOption(element: string, values: string[]): Promise<string> {
    await this.showClickAt(element);
    await new Promise((r) => setTimeout(r, 400));
    const result = await this.callTool("browser_select_option", {
      element,
      values,
    });
    return this.resolveAndTruncate(extractText(result));
  }

  /** Resize the browser viewport. */
  async resize(width: number, height: number): Promise<void> {
    await this.callTool("browser_resize", { width, height });
  }

  async screenshot(): Promise<string | null> {
    const result = await this.callTool("browser_take_screenshot", { type: "jpeg", quality: 50 });
    // In normal mode, the result contains inline base64 image data
    for (const content of result.content || []) {
      if (content.type === "image") return content.data || null;
    }
    // In file output mode, the result contains a text reference to a .jpeg file
    if (this.outputDir) {
      const text = extractText(result);
      const match = text.match(/([^\s"]+\.(?:jpeg|jpg|png))/i);
      if (match) {
        const filePath = match[1];
        const { readFileSync } = await import("fs");
        const { resolve } = await import("path");
        const fullPath = filePath.startsWith("/") ? filePath : resolve(this.outputDir, filePath);
        try {
          return readFileSync(fullPath).toString("base64");
        } catch {
          // File not found, fall through
        }
      }
    }
    return null;
  }

  /** Start video recording (requires --caps devtools). */
  async startVideo(filename?: string): Promise<void> {
    try {
      const args: Record<string, unknown> = { size: { width: 1600, height: 900 } };
      if (filename) args.filename = filename;
      await this.callTool("browser_start_video", args);
      console.error(`[browser] video recording started${filename ? `: ${filename}` : ""}`);
    } catch (err) {
      console.error(`[browser] failed to start video: ${(err as Error).message}`);
    }
  }

  /** Stop video recording and finalize the file. */
  async stopVideo(): Promise<void> {
    try {
      await this.callTool("browser_stop_video", {});
      console.error("[browser] video recording stopped");
    } catch (err) {
      console.error(`[browser] failed to stop video: ${(err as Error).message}`);
    }
  }

  async pressKey(key: string): Promise<string> {
    await this.showKeystroke(`⌨ key: ${key}`);
    const result = await this.callTool("browser_press_key", { key });
    return extractText(result);
  }

  async scroll(x: number, y: number): Promise<string> {
    const result = await this.callTool("browser_scroll", { x, y });
    return extractText(result);
  }

  async waitForText(text: string, timeout?: number): Promise<string> {
    const args: Record<string, unknown> = { text };
    if (timeout) args.timeout = timeout;
    const result = await this.callTool("browser_wait_for", args);
    return extractText(result);
  }

  async evaluate(expression: string): Promise<string> {
    // Playwright MCP expects a `function` param in arrow function format
    const fn = expression.includes("=>") ? expression : `() => (${expression})`;
    const result = await this.callTool("browser_evaluate", { "function": fn });
    return extractText(result);
  }

  async close(opts?: { keepBrowserOpen?: boolean }): Promise<void> {
    if (opts?.keepBrowserOpen) {
      console.error("[browser] keepBrowserOpen=true — leaving browser running");
      // Detach the child process so it survives our exit, then drop references
      // without calling client.close() (which sends SIGTERM to the process).
      if (this.transport) {
        try {
          const pid = this.transport.pid;
          // Access the internal child process and unref it so Node won't wait for it
          if (this.transport._process) {
            this.transport._process.unref();
            this.transport._process.stdin?.unref?.();
            this.transport._process.stdout?.unref?.();
            this.transport._process.stderr?.unref?.();
            // Prevent the transport from killing the process on close
            this.transport._process = undefined;
          }
          console.error(`[browser] detached Playwright MCP process (pid=${pid})`);
        } catch { /* best effort */ }
        this.transport = null;
      }
      this.client = null;
      return;
    }

    if (this.client) {
      try {
        await this.callTool("browser_close");
      } catch {
        /* might already be closed */
      }
      try {
        await this.client.close();
      } catch {
        /* */
      }
      this.client = null;
    }
  }
}

// MCP types
export interface McpToolResult {
  content?: Array<{
    type: "text" | "image";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function extractText(result: McpToolResult): string {
  return (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text || "")
    .join("\n");
}
