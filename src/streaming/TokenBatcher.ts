import type * as vscode from "vscode";
import type { AgentId, ExtensionToWebview } from "../types/protocol.js";

/**
 * Batches streaming tokens at ~60fps before posting to webview.
 *
 * Without batching, each SSE token would trigger a separate postMessage,
 * flooding the webview message queue and causing layout thrashing.
 * This batches at 16ms intervals (~60fps) for smooth rendering.
 */
export class TokenBatcher {
  private buffers: Map<string, string> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_INTERVAL = 16; // ~60fps

  constructor(
    private readonly postMessage: (msg: ExtensionToWebview) => void
  ) {}

  addToken(agentId: AgentId, token: string): void {
    const current = this.buffers.get(agentId) ?? "";
    this.buffers.set(agentId, current + token);

    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.BATCH_INTERVAL);
    }
  }

  endStream(agentId: AgentId): void {
    // Flush any remaining tokens for this agent
    const remaining = this.buffers.get(agentId);
    if (remaining) {
      this.postMessage({
        type: "streamToken",
        agentId,
        content: remaining,
      });
      this.buffers.delete(agentId);
    }

    this.postMessage({ type: "streamEnd", agentId });
  }

  private flush(): void {
    for (const [agentId, content] of this.buffers) {
      if (content) {
        this.postMessage({
          type: "streamToken",
          agentId: agentId as AgentId,
          content,
        });
      }
    }
    this.buffers.clear();
    this.timer = null;
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffers.clear();
  }
}
