/**
 * screencast-remote.ts — Connect to the in-VM proxy's /screencast WebSocket
 * endpoint and receive binary JPEG frames from CDP screencast.
 *
 * The proxy running inside the Freestyle VM handles all CDP protocol details
 * (target discovery, Page.startScreencast, frame acks, throttling). This
 * client simply connects to wss://host/screencast and receives raw JPEG
 * buffers via the same port 443 that serves MCP SSE traffic.
 */

import WebSocket from "ws";

/** How long to wait for the first frame before giving up */
const CONNECT_TIMEOUT_MS = 30_000;

export class RemoteScreencastSession {
  private screencastUrl: string;
  private onFrame: (jpeg: Buffer) => void;
  private ws: WebSocket | null = null;
  private running = false;

  /**
   * @param screencastUrl — WebSocket URL, e.g. `wss://abc.vm.freestyle.sh/screencast`
   * @param onFrame — Callback receiving JPEG buffers for each screencast frame
   */
  constructor(screencastUrl: string, onFrame: (jpeg: Buffer) => void) {
    this.screencastUrl = screencastUrl;
    this.onFrame = onFrame;
  }

  /** Connect to the proxy's screencast WebSocket and start receiving frames. */
  async start(): Promise<void> {
    if (this.running) return;

    console.error(`[screencast] connecting to ${this.screencastUrl} ...`);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Screencast connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
        ws.close();
      }, CONNECT_TIMEOUT_MS);

      const ws = new WebSocket(this.screencastUrl, {
        rejectUnauthorized: false,
      });

      ws.on("open", () => {
        this.ws = ws;
        this.running = true;
        clearTimeout(timeout);
        console.error("[screencast] connected, waiting for frames...");
        resolve();
      });

      ws.on("message", (data: WebSocket.Data) => {
        // Proxy sends raw binary JPEG buffers
        if (Buffer.isBuffer(data)) {
          this.onFrame(data);
        } else if (data instanceof ArrayBuffer) {
          this.onFrame(Buffer.from(data));
        }
      });

      ws.on("error", (err) => {
        console.error("[screencast] WebSocket error:", err.message);
        if (!this.ws) {
          clearTimeout(timeout);
          reject(err);
        }
      });

      ws.on("close", (code, reason) => {
        this.running = false;
        this.ws = null;
        if (!this.running) {
          console.error(`[screencast] connection closed (code=${code}, reason=${reason})`);
        }
      });
    });
  }

  /** Stop streaming and close the WebSocket. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
