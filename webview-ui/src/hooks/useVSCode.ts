import type { WebviewToExtension } from "../../../src/types/protocol";

/**
 * Acquire the VS Code API instance (can only be called once per webview).
 * Provides type-safe postMessage to the extension host.
 */

interface VSCodeAPI {
  postMessage(message: WebviewToExtension): void;
  getState(): unknown;
  setState(state: unknown): void;
}

let api: VSCodeAPI | undefined;

export function getVSCodeAPI(): VSCodeAPI {
  if (!api) {
    // @ts-expect-error — acquireVsCodeApi is injected by VS Code into the webview
    api = acquireVsCodeApi() as VSCodeAPI;
  }
  return api;
}

export function postMessage(message: WebviewToExtension): void {
  getVSCodeAPI().postMessage(message);
}
