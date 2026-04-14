/**
 * MCP Browser Manager — talks to a remote Playwright MCP server running
 * inside an ephemeral Freestyle VM via legacy SSE transport.
 *
 * On launch(), a VM is created (Chromium + @playwright/mcp baked into the
 * image), the MCP server is reached at https://<vmId>.vm.freestyle.sh/sse,
 * and the MCP SDK Client is connected. close() tears the VM down.
 *
 * Also supports CDP screencast streaming via the exposed port 8081 for
 * live JPEG frame broadcasting.
 */

import { createTestVm, destroyTestVm, type FreestyleVm } from "./freestyle";
import { RemoteScreencastSession } from "./screencast-remote";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Client = any;

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
  private vm: FreestyleVm | null = null;
  /** When true, close() will NOT destroy the VM — the VM is owned externally. */
  private vmExternallyManaged = false;

  /** Get the screencast WebSocket URL for direct client connection. */
  get screencastUrl(): string | null {
    return this.vm?.screencastUrl ?? null;
  }

  /** Get the input WebSocket URL for user input injection. */
  get inputUrl(): string | null {
    return this.vm?.inputUrl ?? null;
  }

  /** Get the VNC WebSocket URL for noVNC connection. */
  get vncUrl(): string | null {
    return this.vm?.vncUrl ?? null;
  }

  /** Get the Freestyle VM ID for external lifecycle management. */
  get vmId(): string | null {
    return this.vm?.vmId ?? null;
  }
  private screencast: RemoteScreencastSession | null = null;

  // Track cursor position server-side so it persists across navigations
  private cursorX = 640;  // Start roughly center-screen
  private cursorY = 400;

  /** Directory where Playwright saves the video recording (set by launchLocal). */
  videoDir: string | null = null;

  /**
   * Connect to an already-running Playwright MCP SSE endpoint without creating
   * a VM. Used when the caller (e.g. assrt-freestyle) has already provisioned
   * a VM with Playwright MCP listening locally (e.g. http://localhost:3001/sse)
   * and just wants assrt to drive that existing browser.
   *
   * The caller is responsible for the VM lifecycle; close() will NOT destroy it.
   */
  async launchExisting(sseUrl: string): Promise<void> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );

    console.error(JSON.stringify({ event: "browser.mcp.connect_start", mode: "existing", sseUrl, ts: new Date().toISOString() }));
    const tConn = Date.now();
    const transport = new SSEClientTransport(new URL(sseUrl));
    this.client = new Client(
      { name: "assrt", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(transport);
    this.vmExternallyManaged = true;
    console.error(JSON.stringify({ event: "browser.mcp.connected", mode: "existing", durationMs: Date.now() - tConn, ts: new Date().toISOString() }));
  }

  /** Launch browser in a remote Freestyle VM (production). */
  async launch(): Promise<void> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );

    this.vm = await createTestVm();
    console.error(JSON.stringify({ event: "browser.mcp.connect_start", vmId: this.vm.vmId, sseUrl: this.vm.sseUrl, ts: new Date().toISOString() }));
    const tConn = Date.now();
    const transport = new SSEClientTransport(new URL(this.vm.sseUrl));
    this.client = new Client(
      { name: "assrt", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(transport);
    console.error(JSON.stringify({ event: "browser.mcp.connected", vmId: this.vm.vmId, durationMs: Date.now() - tConn, ts: new Date().toISOString() }));
  }

  /** Launch browser locally via Playwright MCP over stdio (CLI mode).
   *  @param videoDir — Optional directory for Playwright video recording. If provided, a config
   *  file is written with recordVideo enabled and passed to the MCP server via --config.
   *  @param headed — When true, launch a visible browser window. Defaults to headless. */
  async launchLocal(videoDir?: string, headed?: boolean): Promise<void> {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );

    // cli.js isn't in package exports; resolve the package dir at runtime
    const { dirname, join } = await import("path");
    const { tmpdir } = await import("os");
    const { createRequire } = await import("module");
    const require_ = createRequire(import.meta.url);
    const pkgDir = dirname(require_.resolve("@playwright/mcp/package.json"));
    const cliPath = join(pkgDir, "cli.js");
    console.error("[browser] spawning local Playwright MCP via stdio");
    const tConn = Date.now();

    // Use an isolated user-data-dir so assrt's browser doesn't conflict with
    // any other Playwright MCP instance (e.g., the user's Claude Code session)
    const userDataDir = join(tmpdir(), `assrt-browser-${Date.now()}`);
    const args = [cliPath, "--viewport-size", "1600x900", "--user-data-dir", userDataDir];
    if (!headed) args.splice(1, 0, "--headless");
    console.error(`[browser] launch mode: ${headed ? "headed" : "headless"}`);

    // If videoDir is provided, write a temp config file enabling Playwright video recording
    if (videoDir) {
      const { mkdirSync, writeFileSync } = await import("fs");
      mkdirSync(videoDir, { recursive: true });
      const config = {
        browser: {
          contextOptions: {
            recordVideo: {
              dir: videoDir,
              size: { width: 1600, height: 900 },
            },
          },
        },
      };
      const configPath = join(tmpdir(), `assrt-pw-config-${Date.now()}.json`);
      writeFileSync(configPath, JSON.stringify(config));
      args.push("--config", configPath);
      this.videoDir = videoDir;
      console.error(`[browser] video recording enabled → ${videoDir}`);
    }

    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "assrt", version: "1.0.0" },
      { capabilities: {} }
    );
    await this.client.connect(transport);
    console.error(
      `[browser] local MCP connected in ${((Date.now() - tConn) / 1000).toFixed(1)}s`
    );
  }

  // ── CDP Screencast lifecycle ──

  /**
   * Start streaming JPEG frames from the remote browser via CDP screencast.
   * Connects to the in-VM proxy's /screencast WebSocket endpoint on port 443.
   * Should be called after the first navigation so a page target exists.
   */
  async startScreencast(onFrame: (jpeg: Buffer) => void): Promise<void> {
    if (this.screencast || !this.vm) return;

    this.screencast = new RemoteScreencastSession(this.vm.screencastUrl, onFrame);
    try {
      await this.screencast.start();
    } catch (err) {
      console.warn("[browser] screencast start failed, falling back to SSE screenshots:", (err as Error).message);
      this.screencast = null;
    }
  }

  /** Stop the screencast stream. */
  async stopScreencast(): Promise<void> {
    if (this.screencast) {
      await this.screencast.stop();
      this.screencast = null;
    }
  }

  /** Whether the screencast is currently active. */
  get isScreencasting(): boolean {
    return this.screencast !== null;
  }

  /** Call a Playwright MCP tool by name. */
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
      const result = (await this.client.callTool({
        name,
        arguments: args,
      })) as McpToolResult;
      const dt = Date.now() - t;
      const err = result.isError ? " ERROR" : "";
      console.error(`[mcp] ${name}${argSummary} (${dt}ms)${err}`);
      return result;
    } catch (e) {
      console.error(
        `[mcp] ${name}${argSummary} THREW after ${Date.now() - t}ms: ${(e as Error).message}`
      );
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
    return extractText(result);
  }

  async snapshot(): Promise<string> {
    const result = await this.callTool("browser_snapshot");
    return extractText(result);
  }

  async click(element: string, ref?: string): Promise<string> {
    await this.showClickAt(element, ref);
    // Wait for the cursor to glide to the target (0.3s CSS transition + ripple)
    await new Promise((r) => setTimeout(r, 400));
    const args: Record<string, unknown> = { element };
    if (ref) args.ref = ref;
    const result = await this.callTool("browser_click", args);
    return extractText(result);
  }

  async type(element: string, text: string, ref?: string): Promise<string> {
    await this.showClickAt(element, ref);
    await new Promise((r) => setTimeout(r, 400));
    await this.showKeystroke(`⌨ typing: "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}"`);
    const args: Record<string, unknown> = { element, text };
    if (ref) args.ref = ref;
    const result = await this.callTool("browser_type", args);
    return extractText(result);
  }

  async selectOption(element: string, values: string[]): Promise<string> {
    await this.showClickAt(element);
    await new Promise((r) => setTimeout(r, 400));
    const result = await this.callTool("browser_select_option", {
      element,
      values,
    });
    return extractText(result);
  }

  async screenshot(): Promise<string | null> {
    const result = await this.callTool("browser_take_screenshot", { type: "jpeg", quality: 50 });
    for (const content of result.content || []) {
      if (content.type === "image") return content.data || null;
    }
    return null;
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

  /** Trigger ffmpeg encoding of captured screencast frames on the VM. */
  async encodeVideo(): Promise<boolean> {
    if (!this.vm) return false;
    const host = this.vm.sseUrl.replace(/\/sse$/, "").replace(/^https?:\/\//, "");
    const encodeUrl = `https://${host}/video/encode`;
    console.error(`[browser] triggering video encode at ${encodeUrl}`);
    try {
      const resp = await fetch(encodeUrl, { method: "POST" });
      if (!resp.ok) {
        const text = await resp.text();
        console.error(`[browser] video encode failed: ${resp.status} ${text}`);
        return false;
      }
      const result = (await resp.json()) as { frames?: number; sizeBytes?: number };
      console.error(`[browser] video encoded: ${result.frames} frames, ${result.sizeBytes} bytes`);
      return true;
    } catch (err) {
      console.error(`[browser] video encode error:`, err);
      return false;
    }
  }

  /** Download the encoded video from the remote VM. Call encodeVideo() first. */
  async getVideoBuffer(): Promise<Buffer | null> {
    if (!this.vm) return null;
    const host = this.vm.sseUrl.replace(/\/sse$/, "").replace(/^https?:\/\//, "");
    const videoUrl = `https://${host}/video`;
    console.error(`[browser] downloading video from ${videoUrl}`);
    try {
      const resp = await fetch(videoUrl);
      if (!resp.ok) {
        console.error(`[browser] video download failed: ${resp.status}`);
        return null;
      }
      const arrayBuf = await resp.arrayBuffer();
      console.error(`[browser] video downloaded: ${arrayBuf.byteLength} bytes`);
      return Buffer.from(arrayBuf);
    } catch (err) {
      console.error(`[browser] video download error:`, err);
      return null;
    }
  }

  async close(opts?: { skipVmDestroy?: boolean }): Promise<void> {
    // Stop screencast first
    await this.stopScreencast();

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
    if (this.vmExternallyManaged) {
      // VM is owned by the caller — do not destroy it.
      return;
    }
    if (this.vm && !opts?.skipVmDestroy) {
      const vmId = this.vm.vmId;
      this.vm = null;
      console.error(`[browser] close() → destroying VM ${vmId}`);
      destroyTestVm(vmId).catch((err) =>
        console.error(`[browser] failed to destroy VM ${vmId}:`, err)
      );
    }
  }

  /** Destroy the VM. Call after getVideoBuffer() if you used skipVmDestroy. */
  async destroyVm(): Promise<void> {
    if (this.vm) {
      const vmId = this.vm.vmId;
      this.vm = null;
      console.error(`[browser] destroyVm() → destroying VM ${vmId}`);
      destroyTestVm(vmId).catch((err) =>
        console.error(`[browser] failed to destroy VM ${vmId}:`, err)
      );
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
