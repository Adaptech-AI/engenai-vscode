import { fetchEventSource } from "@microsoft/fetch-event-source";

/**
 * SSE client for real-time streams from EnGenAI backend.
 * Uses @microsoft/fetch-event-source for POST support + custom auth headers.
 *
 * Two use cases:
 * 1. Agent message stream — real-time inter-agent chat
 * 2. Dev-vault activity stream — file change notifications
 */

class FatalError extends Error {}
class RetriableError extends Error {}

export interface SSEClientOptions {
  url: string;
  token: string;
  onMessage: (event: { event: string; data: string }) => void;
  onError?: (error: Error) => void;
  onClose?: () => void;
}

export class SSEClient {
  private controller: AbortController | null = null;
  private _isConnected = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(options: SSEClientOptions): Promise<void> {
    this.disconnect();
    this.controller = new AbortController();

    try {
      await fetchEventSource(options.url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${options.token}`,
          Accept: "text/event-stream",
        },
        signal: this.controller.signal,

        async onopen(response) {
          if (
            response.ok &&
            response.headers
              .get("content-type")
              ?.includes("text/event-stream")
          ) {
            return; // Connected
          }
          if (response.status === 401 || response.status === 403) {
            throw new FatalError("Authentication failed");
          }
          throw new RetriableError(`Server returned ${response.status}`);
        },

        onmessage(event) {
          options.onMessage({
            event: event.event || "message",
            data: event.data,
          });
        },

        onclose() {
          options.onClose?.();
          throw new RetriableError("Connection closed by server");
        },

        onerror(err) {
          if (err instanceof FatalError) {
            options.onError?.(err);
            throw err; // Stop retrying
          }
          // Retriable — return delay in ms
          return 5000;
        },
      });
    } catch (e) {
      if (e instanceof FatalError) {
        this._isConnected = false;
        options.onError?.(e);
      }
      // AbortError is expected on disconnect — ignore
    }
  }

  disconnect(): void {
    this._isConnected = false;
    this.controller?.abort();
    this.controller = null;
  }
}
