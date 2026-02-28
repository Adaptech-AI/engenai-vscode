import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";
import { AuthManager } from "../auth/AuthManager.js";
import type { ExtensionToWebview, WebviewToExtension } from "../types/protocol.js";

/**
 * WebviewViewProvider for the EnGenAI chat sidebar.
 *
 * This is the primary UI — works on VS Code, Cursor, Windsurf, and all forks.
 * The webview runs a React app; all API calls happen here in the extension host.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "engenai.chatView";
  private _view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: EnGenAIClient,
    private readonly authManager: AuthManager
  ) {
    // Forward auth state changes to webview
    authManager.onDidChangeState(({ state, user }) => {
      this.postMessage({ type: "connectionState", state, user });

      // Fetch projects when connected
      if (state === "connected") {
        this._loadProjects();
      }
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages FROM webview
    webviewView.webview.onDidReceiveMessage(
      async (message: WebviewToExtension) => {
        try {
          await this._handleWebviewMessage(message);
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : "Unknown error";
          this.postMessage({ type: "error", message: errMsg });
        }
      }
    );

    // Send initial state when webview is ready
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInitialState();
      }
    });
  }

  /** Send a typed message TO the webview */
  postMessage(message: ExtensionToWebview): void {
    this._view?.webview.postMessage(message);
  }

  private async _handleWebviewMessage(msg: WebviewToExtension): Promise<void> {
    switch (msg.type) {
      case "ready":
        this._sendInitialState();
        break;

      case "signIn":
        vscode.commands.executeCommand("engenai.signIn");
        break;

      case "signInWithBrowser":
        vscode.commands.executeCommand("engenai.signInWithBrowser");
        break;

      case "signOut":
        vscode.commands.executeCommand("engenai.signOut");
        break;

      case "selectProject":
        await this._selectProject(msg.projectId);
        break;

      case "deselectProject":
        // TODO: unmount dev-vault, close SSE
        break;

      case "sendMessage":
        await this._sendAgentMessage(msg.text, msg.targetAgent);
        break;

      case "openFile":
        if (msg.uri) {
          const uri = vscode.Uri.parse(msg.uri);
          await vscode.commands.executeCommand("vscode.open", uri);
        }
        break;
    }
  }

  private _sendInitialState(): void {
    this.postMessage({
      type: "connectionState",
      state: this.authManager.state,
      user: this.authManager.user,
    });

    if (this.authManager.state === "connected") {
      this._loadProjects();
    }
  }

  private async _loadProjects(): Promise<void> {
    try {
      const projects = await this.client.listProjects();
      this.postMessage({ type: "projects", projects });
    } catch {
      // Silently fail — projects will load when connection is restored
    }
  }

  private async _selectProject(projectId: string): Promise<void> {
    // Load recent messages
    try {
      const messages = await this.client.getAgentMessages(projectId);
      for (const msg of messages) {
        this.postMessage({ type: "agentMessage", message: msg });
      }
    } catch {
      // Project may not have messages yet
    }

    // TODO: Phase C — mount dev-vault FileSystemProvider
    // TODO: Phase B — start SSE subscription for real-time messages
  }

  private async _sendAgentMessage(
    text: string,
    targetAgent?: string
  ): Promise<void> {
    // Default to Keith if no agent specified
    const agent = targetAgent ?? "keith";

    // Parse slash commands
    const commandMatch = text.match(/^\/(\w+)\s*(.*)/s);
    const command = commandMatch?.[1];
    const prompt = commandMatch ? commandMatch[2] : text;

    // Remove @agent prefix if present
    const cleanPrompt = prompt.replace(/^@\w+\s+/, "");

    // Route based on command
    let taskDescription = cleanPrompt;
    if (command === "plan") {
      taskDescription = `Plan the following: ${cleanPrompt}`;
    } else if (command === "fix") {
      taskDescription = `Fix the following issue: ${cleanPrompt}`;
    } else if (command === "review") {
      taskDescription = `Review the following code: ${cleanPrompt}`;
    } else if (command === "test") {
      taskDescription = `Write tests for: ${cleanPrompt}`;
    }

    // TODO: Get selectedProjectId from state
    // For now, trigger agent via MCP
    try {
      await this.client.triggerAgent("current-project", agent, taskDescription);
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : "Failed to send message";
      this.postMessage({ type: "error", message: errMsg });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    // Check if webview build exists (production) or fall back to placeholder
    const webviewDistUri = vscode.Uri.joinPath(
      this.extensionUri,
      "dist",
      "webview",
      "assets"
    );

    try {
      const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(webviewDistUri, "index.js")
      );
      const styleUri = webview.asWebviewUri(
        vscode.Uri.joinPath(webviewDistUri, "index.css")
      );

      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';
             img-src ${webview.cspSource} https:;
             font-src ${webview.cspSource};">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>EnGenAI</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    } catch {
      // Webview not built yet — show placeholder
      return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
  </style>
</head>
<body>
  <div>
    <p style="font-size: 14px; font-weight: 600;">EnGenAI</p>
    <p style="font-size: 11px; opacity: 0.6;">Run <code>cd webview-ui && npm run build</code> to build the UI</p>
  </div>
</body>
</html>`;
    }
  }
}

function getNonce(): string {
  let text = "";
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
