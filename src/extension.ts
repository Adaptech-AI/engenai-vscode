import * as vscode from "vscode";
import { EnGenAIClient } from "./api/EnGenAIClient.js";
import { AuthManager, registerAuth } from "./auth/AuthManager.js";
import { registerDeviceFlow, startDeviceFlow } from "./auth/DeviceFlow.js";
import { startLocalhostOAuth } from "./auth/LocalhostOAuth.js";
import { SidebarProvider } from "./views/SidebarProvider.js";
import { registerDevVaultFS } from "./fs/DevVaultFS.js";
import { registerAskEnGenAI } from "./commands/askEnGenAI.js";
import { registerChatParticipant } from "./chat/ChatParticipant.js";
import { registerModelProvider } from "./lm/ModelProvider.js";
import type { ConnectionState, UserInfo } from "./types/protocol.js";

let statusBarItem: vscode.StatusBarItem;
let selectedProjectId: string | undefined;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("EnGenAI", {
    log: true,
  });
  outputChannel.info("EnGenAI extension activating...");

  // --- Core services ---
  const client = new EnGenAIClient();
  const authManager = new AuthManager(context.secrets, client);

  const getProjectId = () => selectedProjectId;

  // --- Status bar ---
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "engenai.openChat";
  updateStatusBar("disconnected");
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  authManager.onDidChangeState(({ state, user }) => {
    updateStatusBar(state, user);
  });

  // --- 3-tier sign-in orchestrator ---
  // Tier 1 (Desktop): Localhost PKCE — seamless one-click browser auth
  // Tier 2 (fallback / Web): Device Flow — ENGN-XXXX code, works in SSH/headless
  // Tier 3: PAT key — manual fallback via createSession (AuthenticationProvider)
  const signInHandler = async () => {
    if (vscode.env.uiKind === vscode.UIKind.Desktop) {
      try {
        await startLocalhostOAuth(client, authManager);
        return;
      } catch (e: unknown) {
        // Timeout → fall through to Device Flow silently
        // Any other error → rethrow so the user sees it
        if (e instanceof Error && e.message !== "timeout") throw e;
        outputChannel.info("PKCE localhost auth timed out — falling back to Device Flow");
      }
    }
    await startDeviceFlow(client, authManager);
  };

  // --- Register auth ---
  registerAuth(context, authManager, signInHandler);
  registerDeviceFlow(context, client, authManager);

  // --- Register sidebar ---
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    client,
    authManager
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("engenai.openChat", () => {
      vscode.commands.executeCommand("engenai.chatView.focus");
    })
  );

  // --- Register FileSystemProvider (Dev-Vault read-only mount) ---
  const devVaultFS = registerDevVaultFS(context, client);

  // --- Register context capture (Ask EnGenAI) ---
  registerAskEnGenAI(context, client, getProjectId);

  // --- Feature-gated: Chat Participant (VS Code only) ---
  if (typeof (vscode as any).chat?.createChatParticipant === "function") {
    outputChannel.info(
      "vscode.chat API available — registering @engenai Chat Participant"
    );
    registerChatParticipant(context, client, getProjectId);
  } else {
    outputChannel.info(
      "vscode.chat API not available (fork detected) — skipping Chat Participant"
    );
  }

  // --- Feature-gated: Language Model Provider (VS Code + Copilot only) ---
  if (typeof (vscode as any).lm?.registerLanguageModelChatProvider === "function") {
    outputChannel.info(
      "vscode.lm API available — registering EnGenAI models in picker"
    );
    registerModelProvider(context, client);
  } else {
    outputChannel.info(
      "vscode.lm API not available — skipping Language Model Provider"
    );
  }

  // --- Context menu commands ---
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "engenai.openInBrowser",
      (uri: vscode.Uri) => {
        if (uri?.scheme === "engenai") {
          const projectId = uri.authority.replace("project-", "");
          const filePath = uri.path.replace(/^\/vault/, "");
          const webUrl = `${client.apiUrl}/workbench/${projectId}/files${filePath}`;
          vscode.env.openExternal(vscode.Uri.parse(webUrl));
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "engenai.diffWithLocal",
      async (devVaultUri: vscode.Uri) => {
        if (devVaultUri?.scheme !== "engenai") return;

        const relativePath = devVaultUri.path.replace(/^\/vault/, "");
        const localFolders = vscode.workspace.workspaceFolders?.filter(
          (f) => f.uri.scheme === "file"
        );

        if (!localFolders?.length) {
          vscode.window.showWarningMessage(
            "No local workspace folder found for comparison."
          );
          return;
        }

        const localUri = vscode.Uri.joinPath(
          localFolders[0].uri,
          relativePath
        );
        await vscode.commands.executeCommand(
          "vscode.diff",
          localUri,
          devVaultUri,
          `Local vs EnGenAI: ${relativePath}`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "engenai.copyVaultPath",
      (uri: vscode.Uri) => {
        if (uri?.scheme === "engenai") {
          vscode.env.clipboard.writeText(uri.path);
          vscode.window.showInformationMessage(`Copied: ${uri.path}`);
        }
      }
    )
  );

  // --- Auto-connect on startup ---
  const autoConnect = vscode.workspace
    .getConfiguration("engenai")
    .get<boolean>("autoConnect", true);

  if (autoConnect) {
    const restored = await authManager.tryRestore();
    if (restored) {
      outputChannel.info(
        `Auto-connected as ${authManager.user?.email}`
      );
    }
  }

  // --- Cleanup ---
  context.subscriptions.push(authManager);
  context.subscriptions.push(outputChannel);

  outputChannel.info("EnGenAI extension activated");
}

export function deactivate(): void {
  // Cleanup handled by disposables
}

function updateStatusBar(state: ConnectionState, user?: UserInfo): void {
  switch (state) {
    case "connected":
      statusBarItem.text = `$(robot) EnGenAI: ${user?.email ?? "Connected"}`;
      statusBarItem.tooltip = `Connected to EnGenAI as ${user?.email}\nOrg: ${user?.orgName}\nClick to open chat`;
      statusBarItem.backgroundColor = undefined;
      break;
    case "connecting":
      statusBarItem.text = "$(loading~spin) EnGenAI: Connecting...";
      statusBarItem.tooltip = "Connecting to EnGenAI...";
      statusBarItem.backgroundColor = undefined;
      break;
    case "disconnected":
      statusBarItem.text = "$(sign-in) EnGenAI: Sign In";
      statusBarItem.tooltip = "Click to sign in to EnGenAI";
      statusBarItem.backgroundColor = undefined;
      break;
    case "invalid_key":
      statusBarItem.text = "$(error) EnGenAI: Invalid Key";
      statusBarItem.tooltip =
        "Your API key is invalid or revoked. Click to sign in again.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.errorBackground"
      );
      break;
    case "offline":
      statusBarItem.text = "$(cloud-offline) EnGenAI: Offline";
      statusBarItem.tooltip =
        "Cannot reach EnGenAI server. Will retry automatically.";
      statusBarItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      break;
  }
}
