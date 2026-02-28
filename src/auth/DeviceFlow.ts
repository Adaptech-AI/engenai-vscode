import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";
import { AuthManager } from "./AuthManager.js";

/**
 * OAuth Device Flow (RFC 8628) for EnGenAI.
 *
 * Flow:
 * 1. Extension requests device code from POST /auth/device
 * 2. Shows modal with ENGN-XXXX code, copies to clipboard, opens browser
 * 3. User approves in browser
 * 4. Extension polls POST /auth/device/token every 5s
 * 5. On success, stores token via AuthManager
 */
export async function startDeviceFlow(
  client: EnGenAIClient,
  authManager: AuthManager
): Promise<void> {
  // Step 1: Request device code
  const device = await client.requestDeviceCode();

  // Step 2: Show code and offer to open browser
  const choice = await vscode.window.showInformationMessage(
    `Enter code ${device.user_code} at ${device.verification_uri}`,
    { modal: true, detail: "The code has been copied to your clipboard." },
    "Open Browser",
    "Cancel"
  );

  if (choice !== "Open Browser") return;

  await vscode.env.clipboard.writeText(device.user_code);
  await vscode.env.openExternal(vscode.Uri.parse(device.verification_uri));

  // Step 3: Poll for token with progress
  const token = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Waiting for EnGenAI authorization...",
      cancellable: true,
    },
    async (_progress, cancellationToken) => {
      return pollForToken(
        client,
        device.device_code,
        device.interval,
        device.expires_in,
        cancellationToken
      );
    }
  );

  if (!token) {
    vscode.window.showWarningMessage(
      "EnGenAI device authorization timed out or was cancelled."
    );
    return;
  }

  // Step 4: Store token
  await authManager.storeDeviceFlowToken(
    token.access_token,
    token.user_info
  );
  vscode.window.showInformationMessage(
    `Signed in to EnGenAI as ${token.user_info.email}`
  );
}

async function pollForToken(
  client: EnGenAIClient,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  cancellationToken: vscode.CancellationToken
): Promise<{ access_token: string; user_info: any } | null> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    if (cancellationToken.isCancellationRequested) return null;

    await sleep(pollInterval);

    if (cancellationToken.isCancellationRequested) return null;

    try {
      const result = await client.pollDeviceToken(deviceCode);
      if (result) return result;
      // authorization_pending — keep polling
    } catch (e: any) {
      if (e.message === "slow_down") {
        pollInterval = Math.min(pollInterval * 2, 30_000);
        continue;
      }
      if (
        e.message === "expired_token" ||
        e.message === "access_denied"
      ) {
        return null;
      }
      // Transient error — keep polling
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Register Device Flow command.
 */
export function registerDeviceFlow(
  context: vscode.ExtensionContext,
  client: EnGenAIClient,
  authManager: AuthManager
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("engenai.signInWithBrowser", () =>
      startDeviceFlow(client, authManager)
    )
  );
}
