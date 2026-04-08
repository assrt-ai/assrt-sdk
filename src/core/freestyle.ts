/**
 * Freestyle VM management for Assrt.
 *
 * Uses live snapshots to skip the ~11s service boot time. On first run,
 * a VM boots normally, waits for all services, then snapshots the running
 * state. Subsequent VMs restore from that snapshot with services already up.
 *
 * The snapshotId is persisted locally in ~/.assrt/snapshots.json
 * (keyed by spec hash) so it survives process restarts.
 *
 * Each test run gets its own isolated VM reachable via a *.vm.freestyle.sh
 * domain serving the Playwright MCP server over legacy SSE transport.
 */

import { Agent, fetch as undiciFetch } from "undici";
import crypto from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Structured log with [freestyle] prefix so Cloud Run captures it as textPayload. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flog(level: "log" | "warn" | "error", data: Record<string, any>) {
  const line = "[freestyle] " + JSON.stringify({ ...data, ts: new Date().toISOString() });
  console[level](line);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let freestyleModule: any = null;

async function getFreestyle() {
  if (!freestyleModule) {
    freestyleModule = await import("freestyle-sandboxes");
  }
  return freestyleModule;
}

// Long-timeout undici agent so the initial image build (first-ever cache miss,
// ~5 min) doesn't hit the 5-minute default headersTimeout.
const dispatcher = new Agent({
  headersTimeout: 15 * 60 * 1000,
  bodyTimeout: 15 * 60 * 1000,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildClient(): Promise<any> {
  const { Freestyle } = await getFreestyle();
  const apiKey = process.env.FREESTYLE_API_KEY;
  if (!apiKey) throw new Error("FREESTYLE_API_KEY not configured");
  return new Freestyle({
    apiKey,
    fetch: (url: string, opts: Record<string, unknown> = {}) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      undiciFetch(url, { ...opts, dispatcher } as any) as any,
  });
}

export interface FreestyleVm {
  vmId: string;
  /** Fully qualified host, e.g. `<id>.vm.freestyle.sh`. Use https://host for SSE. */
  host: string;
  /** URL of the MCP SSE endpoint to pass to SSEClientTransport. */
  sseUrl: string;
  /** WebSocket URL for CDP screencast frames, e.g. `wss://host/screencast`. */
  screencastUrl: string;
  /** WebSocket URL for user input injection, e.g. `wss://host/input`. */
  inputUrl: string;
  /** WebSocket URL for noVNC connection, e.g. `wss://host/vnc`. */
  vncUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vm: any;
}

// ── VM Spec ──

const proxyScript = `
const http = require('http');
const WS = require('ws');

const MCP_PORT = 3001;
const CDP_PORT = 9222;

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const FRAMES_DIR = '/tmp/video/frames';
const VIDEO_FILE = '/tmp/video/recording.webm';

// Ensure frames directory exists
try { fs.mkdirSync(FRAMES_DIR, { recursive: true }); } catch {}

// Global frame counter for saving screencast JPEGs
let frameIndex = 0;

const server = http.createServer((req, res) => {
  // POST /video/encode — combine saved screencast frames into mp4 via ffmpeg
  if (req.url === '/video/encode' && req.method === 'POST') {
    try {
      const files = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith('.jpg')).sort();
      if (files.length === 0) { res.writeHead(404); res.end('no frames captured'); return; }
      console.log('[proxy] encoding ' + files.length + ' frames to webm');
      execSync(
        'ffmpeg -y -framerate 15 -i ' + FRAMES_DIR + '/frame%06d.jpg ' +
        '-c:v libvpx -b:v 1M -pix_fmt yuv420p ' +
        VIDEO_FILE,
        { timeout: 60000, stdio: 'pipe' }
      );
      const stat = fs.statSync(VIDEO_FILE);
      console.log('[proxy] video encoded: ' + stat.size + ' bytes');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, frames: files.length, sizeBytes: stat.size }));
    } catch (e) {
      console.error('[proxy] encode error:', e.message);
      res.writeHead(500); res.end(e.message);
    }
    return;
  }
  // GET /video — serve the encoded mp4
  if (req.url === '/video' && req.method === 'GET') {
    try {
      if (!fs.existsSync(VIDEO_FILE)) { res.writeHead(404); res.end('no video'); return; }
      const stat = fs.statSync(VIDEO_FILE);
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': stat.size });
      fs.createReadStream(VIDEO_FILE).pipe(res);
    } catch (e) { res.writeHead(500); res.end(e.message); }
    return;
  }
  const proxy = http.request(
    { hostname: '127.0.0.1', port: MCP_PORT, path: req.url, method: req.method, headers: req.headers },
    (pRes) => { res.writeHead(pRes.statusCode, pRes.headers); pRes.pipe(res); }
  );
  req.pipe(proxy);
  proxy.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
});

const wss = new WS.WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/screencast') {
    wss.handleUpgrade(req, socket, head, (ws) => startRelay(ws));
  } else if (req.url === '/input') {
    wss.handleUpgrade(req, socket, head, (ws) => startInputRelay(ws));
  } else if (req.url === '/vnc') {
    // WS-to-WS proxy: accept incoming WebSocket, connect to local websockify, pipe binary data
    wss.handleUpgrade(req, socket, head, (clientWs) => {
      const upstream = new WS('ws://127.0.0.1:5901', ['binary']);
      upstream.binaryType = 'arraybuffer';
      clientWs.binaryType = 'arraybuffer';

      upstream.on('open', () => {
        console.log('[proxy] VNC WebSocket relay connected');
      });

      upstream.on('message', (data) => {
        if (clientWs.readyState === 1) clientWs.send(data);
      });

      clientWs.on('message', (data) => {
        if (upstream.readyState === 1) upstream.send(data);
      });

      upstream.on('close', () => { if (clientWs.readyState === 1) clientWs.close(); });
      upstream.on('error', () => { if (clientWs.readyState === 1) clientWs.close(); });
      clientWs.on('close', () => { if (upstream.readyState === 1) upstream.close(); });
      clientWs.on('error', () => { if (upstream.readyState === 1) upstream.close(); });
    });
  } else {
    socket.destroy();
  }
});

function startRelay(clientWs) {
  http.get('http://127.0.0.1:' + CDP_PORT + '/json', (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const page = targets.find((t) => t.type === 'page');
        if (!page || !page.webSocketDebuggerUrl) { clientWs.close(1011, 'no page target'); return; }
        connectCdp(clientWs, page.webSocketDebuggerUrl);
      } catch (e) { clientWs.close(1011, 'json parse error'); }
    });
  }).on('error', () => clientWs.close(1011, 'cdp unreachable'));
}

function connectCdp(clientWs, wsUrl) {
  const cdp = new WS(wsUrl);
  let id = 0;
  let lastFrame = 0;

  cdp.on('open', () => {
    cdp.send(JSON.stringify({ id: ++id, method: 'Page.enable' }));
    cdp.send(JSON.stringify({
      id: ++id, method: 'Page.startScreencast',
      params: { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 900, everyNthFrame: 2 }
    }));
    console.log('[proxy] CDP screencast started');
  });

  cdp.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.method === 'Page.screencastFrame') {
        cdp.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: msg.params.sessionId } }));
        const now = Date.now();
        if (now - lastFrame < 66) return;
        lastFrame = now;
        // Save frame to disk for video encoding
        const buf = Buffer.from(msg.params.data, 'base64');
        const fname = 'frame' + String(frameIndex++).padStart(6, '0') + '.jpg';
        fs.writeFile(path.join(FRAMES_DIR, fname), buf, () => {});
        // Forward to WebSocket client
        if (clientWs.readyState === 1) {
          clientWs.send(buf);
        }
      }
    } catch {}
  });

  cdp.on('close', () => { if (clientWs.readyState === 1) clientWs.close(); });
  cdp.on('error', () => { if (clientWs.readyState === 1) clientWs.close(); });
  clientWs.on('close', () => { try { cdp.send(JSON.stringify({ id: ++id, method: 'Page.stopScreencast' })); } catch {} cdp.close(); });
}

function startInputRelay(clientWs) {
  http.get('http://127.0.0.1:' + CDP_PORT + '/json', (res) => {
    let data = '';
    res.on('data', (c) => data += c);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const page = targets.find((t) => t.type === 'page');
        if (!page || !page.webSocketDebuggerUrl) { clientWs.close(1011, 'no page target'); return; }
        connectInputCdp(clientWs, page.webSocketDebuggerUrl);
      } catch (e) { clientWs.close(1011, 'json parse error'); }
    });
  }).on('error', () => clientWs.close(1011, 'cdp unreachable'));
}

function connectInputCdp(clientWs, wsUrl) {
  const cdp = new WS(wsUrl);
  let id = 1000;

  cdp.on('open', () => {
    cdp.send(JSON.stringify({ id: ++id, method: 'DOM.enable' }));
    cdp.send(JSON.stringify({ id: ++id, method: 'Overlay.enable' }));
    console.log('[proxy] CDP input relay connected');
  });

  cdp.on('error', (err) => {
    console.log('[proxy] CDP input error: ' + err.message);
  });

  cdp.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.method === 'Overlay.inspectNodeRequested') {
        clientWs.send(JSON.stringify({ type: 'inspectNode', backendNodeId: msg.params.backendNodeId }));
      }
    } catch {}
  });

  clientWs.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'mouse') {
        cdp.send(JSON.stringify({
          id: ++id, method: 'Input.dispatchMouseEvent',
          params: { type: msg.action, x: msg.x, y: msg.y, button: msg.button || 'left', clickCount: msg.clickCount || 1 }
        }));
      } else if (msg.type === 'navigate') {
        cdp.send(JSON.stringify({ id: ++id, method: 'Page.navigate', params: { url: msg.url } }));
      } else if (msg.type === 'key') {
        cdp.send(JSON.stringify({
          id: ++id, method: 'Input.dispatchKeyEvent',
          params: { type: msg.action, key: msg.key, code: msg.code, text: msg.text || '', windowsVirtualKeyCode: msg.keyCode || 0, nativeVirtualKeyCode: msg.keyCode || 0 }
        }));
      } else if (msg.type === 'scroll') {
        cdp.send(JSON.stringify({
          id: ++id, method: 'Input.dispatchMouseEvent',
          params: { type: 'mouseWheel', x: msg.x, y: msg.y, deltaX: msg.deltaX || 0, deltaY: msg.deltaY || 0 }
        }));
      } else if (msg.type === 'highlight') {
        if (msg.action === 'inspect') {
          cdp.send(JSON.stringify({
            id: ++id, method: 'Overlay.setInspectMode',
            params: { mode: msg.enabled ? 'searchForNode' : 'none', highlightConfig: { showInfo: true, showStyles: true, showExtensionLines: false, contentColor: { r: 111, g: 168, b: 220, a: 0.66 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.55 }, marginColor: { r: 246, g: 178, b: 107, a: 0.66 } } }
          }));
        } else if (msg.action === 'node' && msg.backendNodeId) {
          cdp.send(JSON.stringify({
            id: ++id, method: 'Overlay.highlightNode',
            params: { backendNodeId: msg.backendNodeId, highlightConfig: { showInfo: true, showStyles: true, contentColor: { r: 111, g: 168, b: 220, a: 0.66 }, paddingColor: { r: 147, g: 196, b: 125, a: 0.55 }, marginColor: { r: 246, g: 178, b: 107, a: 0.66 } } }
          }));
        } else if (msg.action === 'hide') {
          cdp.send(JSON.stringify({ id: ++id, method: 'Overlay.hideHighlight' }));
        }
      }
    } catch {}
  });

  cdp.on('close', () => { if (clientWs.readyState === 1) clientWs.close(); });
  cdp.on('error', () => { if (clientWs.readyState === 1) clientWs.close(); });
  clientWs.on('close', () => { cdp.close(); });
}

server.listen(3000, '0.0.0.0', () => console.log('[proxy] listening on 3000'));
`.trim();

const startupScript = [
  "#!/bin/bash",
  "set -e",
  "",
  "# Start Xvfb virtual display",
  "Xvfb :99 -screen 0 1600x900x24 -ac &",
  "sleep 1",
  "export DISPLAY=:99",
  "",
  "# Start Chromium on the virtual display with remote debugging",
  "chromium --no-sandbox --disable-gpu --disable-software-rasterizer \\",
  "  --window-size=1600,900 --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 &",
  "",
  "# Wait for CDP to be ready (up to 30s)",
  "for i in $(seq 1 30); do",
  "  if timeout 1 bash -c '</dev/tcp/127.0.0.1/9222' 2>/dev/null; then",
  '    echo "[startup] CDP ready on port 9222"',
  "    break",
  "  fi",
  "  sleep 1",
  "done",
  "",
  "# Start x11vnc on the Xvfb display (no password, listen on port 5900)",
  "x11vnc -display :99 -nopw -forever -shared -rfbport 5900 -q &",
  "",
  "# Start websockify to expose VNC over WebSocket on port 5901",
  "websockify 0.0.0.0:5901 localhost:5900 &",
  "",
  "# Start MCP on port 3001 (behind the proxy)",
  "npx @playwright/mcp --cdp-endpoint http://127.0.0.1:9222 \\",
  "  --port 3001 --host 0.0.0.0 --allowed-hosts '*' &",
  "",
  "# Wait for MCP to be ready",
  "for i in $(seq 1 30); do",
  "  if timeout 1 bash -c '</dev/tcp/127.0.0.1/3001' 2>/dev/null; then",
  '    echo "[startup] MCP ready on port 3001"',
  "    break",
  "  fi",
  "  sleep 1",
  "done",
  "",
  "# Start the proxy on port 3000 (the externally exposed port)",
  "exec node /opt/proxy.js",
].join("\n");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildVmSpec(): any {
  const { VmSpec, VmBaseImage } = freestyleModule;

  return new VmSpec()
    .baseImage(
      new VmBaseImage("FROM debian:bookworm-slim").runCommands(
        "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends " +
          "ca-certificates nodejs npm chromium fonts-liberation libgbm1 libnss3 libxss1 ffmpeg " +
          "xvfb x11vnc websockify && " +
          "npm install -g @playwright/mcp@0.0.70 ws && " +
          "node --version && npm --version && which chromium",
        `printf '%s' '${startupScript.replace(/'/g, "'\\''")}' > /opt/startup.sh && chmod +x /opt/startup.sh`,
        `echo '${Buffer.from(proxyScript).toString("base64")}' | base64 -d > /opt/proxy.js`
      )
    )
    .idleTimeoutSeconds(600)
    .systemdService({
      name: "playwright-mcp",
      mode: "service",
      exec: ["/opt/startup.sh"],
      env: {
        PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: "/usr/bin/chromium",
        NODE_PATH: "/usr/lib/node_modules:/usr/local/lib/node_modules",
      },
    });
}

// ── Live snapshot: cache a snapshot of a fully-booted VM ──

// In-memory cache (fast path within same Cloud Run instance)
let cachedSnapshotId: string | null = null;
let cachedSpecHash: string | null = null;

/** Hash the VM spec content so we know when it changes. */
function computeSpecHash(): string {
  return crypto.createHash("sha256").update(startupScript + proxyScript).digest("hex").slice(0, 16);
}

/** Path to local snapshot cache file. */
function getSnapshotCachePath(): string {
  const dir = join(homedir(), ".assrt");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, "snapshots.json");
}

/** Read all cached snapshots from disk. */
function readSnapshotCache(): Record<string, { snapshotId: string; created_at: string }> {
  const cachePath = getSnapshotCachePath();
  try {
    if (existsSync(cachePath)) {
      return JSON.parse(readFileSync(cachePath, "utf-8"));
    }
  } catch {
    // Corrupted cache, start fresh
  }
  return {};
}

/** Write snapshot cache to disk. */
function writeSnapshotCache(cache: Record<string, { snapshotId: string; created_at: string }>): void {
  try {
    writeFileSync(getSnapshotCachePath(), JSON.stringify(cache, null, 2));
  } catch (err) {
    flog("warn", { event: "freestyle.snapshot.cache_write_error", error: (err as Error).message });
  }
}

/** Read snapshotId from local file cache. */
async function readSnapshotFromStore(specHash: string): Promise<string | null> {
  try {
    const cache = readSnapshotCache();
    if (cache[specHash]) {
      flog("log", { event: "freestyle.snapshot.cache_hit", specHash, snapshotId: cache[specHash].snapshotId, source: "file" });
      return cache[specHash].snapshotId;
    }
  } catch (err) {
    flog("warn", { event: "freestyle.snapshot.store_read_error", specHash, error: (err as Error).message });
  }
  return null;
}

/** Write snapshotId to local file cache. */
async function writeSnapshotToStore(specHash: string, snapshotId: string): Promise<void> {
  try {
    const cache = readSnapshotCache();
    cache[specHash] = { snapshotId, created_at: new Date().toISOString() };
    writeSnapshotCache(cache);
    flog("log", { event: "freestyle.snapshot.store_written", specHash, snapshotId });
  } catch (err) {
    flog("warn", { event: "freestyle.snapshot.store_write_error", specHash, error: (err as Error).message });
  }
}

/**
 * Wait until port 3000 is up inside the VM (proxy ready = all services ready).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function waitForProxy(vm: any, vmId: string, timeoutS: number): Promise<boolean> {
  const tWait = Date.now();
  for (let i = 0; i < timeoutS; i++) {
    try {
      const r = await vm.exec("timeout 1 bash -c '</dev/tcp/127.0.0.1/3000' && echo UP || echo DOWN");
      if (r.stdout && r.stdout.includes("UP")) {
        flog("log", { event: "freestyle.proxy.ready", vmId, durationMs: Date.now() - tWait });
        return true;
      }
      if (i > 0 && i % 10 === 0) {
        const ports = await vm.exec(
          "timeout 1 bash -c '</dev/tcp/127.0.0.1/9222' 2>/dev/null && echo 'cdp=UP' || echo 'cdp=DOWN'; " +
          "timeout 1 bash -c '</dev/tcp/127.0.0.1/3001' 2>/dev/null && echo 'mcp=UP' || echo 'mcp=DOWN'"
        );
        flog("log", { event: "freestyle.proxy.waiting", vmId, elapsedS: i, ports: (ports.stdout || "").trim() });
      }
    } catch { /* vm still booting */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  flog("warn", { event: "freestyle.proxy.timeout", vmId, durationMs: Date.now() - tWait });
  return false;
}

/**
 * Build a fresh live snapshot: boot a VM from spec, wait for services, snapshot, destroy.
 */
async function buildLiveSnapshot(): Promise<string> {
  await getFreestyle();
  const freestyle = await buildClient();
  const spec = buildVmSpec();

  flog("log", { event: "freestyle.snapshot.build_start" });
  const t0 = Date.now();

  const { vmId, vm } = await freestyle.vms.create(spec);
  flog("log", { event: "freestyle.snapshot.vm_created", vmId, durationMs: Date.now() - t0 });

  const ready = await waitForProxy(vm, vmId, 90);
  if (!ready) {
    await freestyle.vms.delete({ vmId }).catch(() => {});
    throw new Error("Snapshot source VM proxy never became ready");
  }

  const tSnap = Date.now();
  const snapResult = await vm.snapshot({ name: "assrt-chromium-mcp-ready" });
  const snapshotId = snapResult.snapshotId;
  flog("log", { event: "freestyle.snapshot.created", snapshotId, snapshotDurationMs: Date.now() - tSnap, totalDurationMs: Date.now() - t0 });

  await freestyle.vms.delete({ vmId }).catch(() => {});
  return snapshotId;
}

/**
 * Get a live snapshot with all services running.
 * Checks in-memory cache, then Firestore, then builds a new one.
 */
async function ensureLiveSnapshot(): Promise<string> {
  const specHash = computeSpecHash();

  // 1. In-memory cache (same Cloud Run instance)
  if (cachedSnapshotId && cachedSpecHash === specHash) {
    flog("log", { event: "freestyle.snapshot.cache_hit", specHash, snapshotId: cachedSnapshotId, source: "memory" });
    return cachedSnapshotId;
  }

  // 2. Local file cache (survives process restarts)
  const storedId = await readSnapshotFromStore(specHash);
  if (storedId) {
    cachedSnapshotId = storedId;
    cachedSpecHash = specHash;
    return storedId;
  }

  // 3. Build a new snapshot
  flog("log", { event: "freestyle.snapshot.cache_miss", specHash });
  const snapshotId = await buildLiveSnapshot();

  // Persist to both caches
  cachedSnapshotId = snapshotId;
  cachedSpecHash = specHash;
  await writeSnapshotToStore(specHash, snapshotId);

  return snapshotId;
}

/** Invalidate the snapshot cache (both in-memory and local file). */
async function invalidateSnapshotCache(reason: string): Promise<void> {
  const specHash = computeSpecHash();
  flog("warn", { event: "freestyle.snapshot.invalidated", specHash, reason, oldSnapshotId: cachedSnapshotId });
  cachedSnapshotId = null;
  cachedSpecHash = null;
  try {
    const cache = readSnapshotCache();
    delete cache[specHash];
    writeSnapshotCache(cache);
  } catch (err) {
    flog("warn", { event: "freestyle.snapshot.invalidate_store_error", error: (err as Error).message });
  }
}

/**
 * Create a VM from a snapshot, extracting the host domain.
 * Throws on any Freestyle error (including RESUMED_VM_NON_RESPONSIVE).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function createVmFromSnapshot(freestyle: any, snapshotId: string): Promise<FreestyleVm> {
  // SDK filters out built-in *.vm.freestyle.sh domains from the return value.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = freestyle as any;
  const originalPost = client._apiClient.post.bind(client._apiClient);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rawCreate: any = null;
  client._apiClient.post = async (path: string, ...args: unknown[]) => {
    const r = await originalPost(path, ...args);
    if (path === "/v1/vms") rawCreate = r;
    return r;
  };

  const t0 = Date.now();
  flog("log", { event: "freestyle.vm.create_start", snapshotId });
  const { vmId, vm } = await freestyle.vms.create({
    snapshotId,
    ports: [{ port: 443, targetPort: 3000 }],
  });

  const host = rawCreate?.domains?.[0];
  const vmCreateMs = Date.now() - t0;
  flog("log", { event: "freestyle.vm.created", vmId, host, durationMs: vmCreateMs, fromSnapshot: true });
  if (!host) {
    try { await freestyle.vms.delete({ vmId }); } catch { /* ignore */ }
    throw new Error("Freestyle did not return a built-in .vm.freestyle.sh domain");
  }

  // With a live snapshot, services should already be running.
  // Short timeout since we expect near-instant readiness.
  await waitForProxy(vm, vmId, 30);

  // CDP check
  try {
    const cdpCheck = await vm.exec("timeout 1 bash -c '</dev/tcp/127.0.0.1/9222' && echo UP || echo DOWN");
    flog("log", { event: "freestyle.cdp.check", vmId, status: cdpCheck.stdout?.trim() || "unknown" });
  } catch {
    flog("warn", { event: "freestyle.cdp.check", vmId, status: "failed" });
  }

  return {
    vmId,
    host,
    sseUrl: `https://${host}/sse`,
    screencastUrl: `wss://${host}/screencast`,
    inputUrl: `wss://${host}/input`,
    vncUrl: `wss://${host}/vnc`,
    vm,
  };
}

/**
 * Create a Freestyle VM. Uses a live snapshot if available for fast boot.
 * Falls back to booting from spec on first call (and creates the snapshot for next time).
 * If the snapshot is stale (RESUMED_VM_NON_RESPONSIVE), invalidates cache and rebuilds.
 */
export async function createTestVm(): Promise<FreestyleVm> {
  await getFreestyle();
  const freestyle = await buildClient();

  const snapshotId = await ensureLiveSnapshot();

  try {
    return await createVmFromSnapshot(freestyle, snapshotId);
  } catch (err) {
    const msg = (err as Error).message || "";
    if (msg.includes("RESUMED_VM_NON_RESPONSIVE") || msg.includes("not responsive") || msg.includes("INTERNAL_ERROR")) {
      flog("warn", { event: "freestyle.vm.snapshot_stale", snapshotId, error: msg });
      await invalidateSnapshotCache(msg);

      // Rebuild a fresh snapshot and retry once
      const freshSnapshotId = await ensureLiveSnapshot();
      flog("log", { event: "freestyle.vm.retry_with_fresh_snapshot", freshSnapshotId });
      return await createVmFromSnapshot(freestyle, freshSnapshotId);
    }
    throw err;
  }
}

/**
 * Destroy a Freestyle VM after a test run completes.
 */
export async function destroyTestVm(vmId: string): Promise<void> {
  try {
    const freestyle = await buildClient();
    await freestyle.vms.delete({ vmId });
    flog("log", { event: "freestyle.vm.deleted", vmId });
  } catch (err) {
    flog("error", { event: "freestyle.vm.delete_failed", vmId, error: (err as Error).message });
  }
}

/** Check if Freestyle is configured (API key present). */
export function isFreestyleConfigured(): boolean {
  return !!process.env.FREESTYLE_API_KEY;
}
