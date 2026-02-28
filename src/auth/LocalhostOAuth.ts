import * as crypto from "crypto";
import * as http from "http";
import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";
import { AuthManager } from "./AuthManager.js";

/**
 * Localhost PKCE OAuth flow (Tier 1 auth — default for desktop IDEs).
 *
 * Mirrors how GitHub Copilot and the GitHub CLI authenticate:
 *   1. Start an ephemeral HTTP server on a random localhost port
 *   2. Generate PKCE code_verifier + code_challenge (S256)
 *   3. Open browser → backend validates session → consent page → Approve
 *   4. Browser redirects to localhost callback → extract code
 *   5. Exchange code + code_verifier for access/refresh tokens
 *   6. Store via AuthManager (same path as Device Flow)
 *
 * Throws "timeout" error after 5 minutes so callers can fall back to
 * Device Flow (Tier 2) without showing an error to the user.
 *
 * Sprint 17: Task 17-auth-1
 */

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function startLocalhostOAuth(
  client: EnGenAIClient,
  authManager: AuthManager
): Promise<void> {
  // 1. PKCE: code_verifier is a random 32-byte value encoded as base64url
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");

  const state = crypto.randomUUID();

  // 2. Start localhost server (OS picks a free port)
  const { server, port, callbackPromise } = await startCallbackServer(state);

  try {
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const baseUrl = client.apiUrl;

    const params = new URLSearchParams({
      client_id: "engenai-vscode",
      response_type: "code",
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
    });

    // 3. Open browser — backend will redirect to consent page
    await vscode.env.openExternal(
      vscode.Uri.parse(`${baseUrl}/api/v1/oauth/authorize?${params}`)
    );

    // 4. Race: wait for callback or timeout
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS)
    );

    const code = await Promise.race([callbackPromise, timeoutPromise]);

    // 5. Exchange code for tokens (PKCE verification happens server-side)
    const tokenData = await client.exchangeOAuthCode(code, codeVerifier, redirectUri);

    // 6. Store tokens — same path as Device Flow
    await authManager.storeDeviceFlowToken(tokenData.access_token, tokenData.user_info);
    vscode.window.showInformationMessage(
      `Signed in to EnGenAI as ${tokenData.user_info.email}`
    );
  } finally {
    server.close();
  }
}

// ---------------------------------------------------------------------------
// Localhost callback server
// ---------------------------------------------------------------------------

function startCallbackServer(expectedState: string): Promise<{
  server: http.Server;
  port: number;
  callbackPromise: Promise<string>;
}> {
  return new Promise((resolve) => {
    let resolveCode: (code: string) => void;
    let rejectCode: (err: Error) => void;

    const callbackPromise = new Promise<string>((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");

        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        if (error || !code) {
          const msg = error ?? "No authorization code received";
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(buildHtmlResponse(false, "Authorization failed or was denied."));
          rejectCode(new Error(msg));
          return;
        }

        if (returnedState !== expectedState) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(buildHtmlResponse(false, "State mismatch — possible CSRF. Try again."));
          rejectCode(new Error("state_mismatch"));
          return;
        }

        // Success — tell the browser to close
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(buildHtmlResponse(true, "Return to your IDE — you&apos;re signed in!"));
        resolveCode(code);
      } catch (e) {
        res.writeHead(500);
        res.end("Internal error");
        rejectCode(e instanceof Error ? e : new Error(String(e)));
      }
    });

    // Listen on 127.0.0.1 (loopback only — not exposed on LAN)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, callbackPromise });
    });
  });
}

// ---------------------------------------------------------------------------
// Minimal success/failure HTML served to the browser after redirect
// ---------------------------------------------------------------------------

function buildHtmlResponse(success: boolean, message: string): string {
  const icon = success ? "✅" : "❌";
  const title = success ? "Authorized!" : "Authorization Failed";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>EnGenAI Authorization</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex; align-items: center; justify-content: center;
      min-height: 100vh; background: #0d1117; color: #e6edf3;
    }
    .card {
      text-align: center; padding: 2rem 2.5rem;
      border: 1px solid #30363d; border-radius: 12px; max-width: 340px;
    }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; margin-bottom: .5rem; }
    p { color: #8d96a0; font-size: .875rem; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
  </div>
</body>
</html>`;
}
