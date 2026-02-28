import * as vscode from "vscode";
import { EnGenAIClient, AuthError } from "../api/EnGenAIClient.js";
import type { ConnectionState, UserInfo } from "../types/protocol.js";

const AUTH_TYPE = "engenai";
const AUTH_NAME = "EnGenAI";
const SESSIONS_KEY = "engenai.sessions";
const TOKEN_KEY = "engenai.pat";

/**
 * Manages authentication state for the EnGenAI extension.
 *
 * Two auth methods:
 * 1. PAT key (eng_live_* / eng_test_*) — user pastes key, stored in SecretStorage
 * 2. Device Flow (RFC 8628) — user approves in browser, token exchanged
 *
 * Integrates with VS Code's Accounts menu via AuthenticationProvider.
 */
export class AuthManager implements vscode.AuthenticationProvider, vscode.Disposable {
  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private _onDidChangeState = new vscode.EventEmitter<{
    state: ConnectionState;
    user?: UserInfo;
  }>();
  readonly onDidChangeState = this._onDidChangeState.event;

  private _state: ConnectionState = "disconnected";
  private _user: UserInfo | undefined;
  private _healthCheckInterval: ReturnType<typeof setInterval> | undefined;
  private _disposables: vscode.Disposable[] = [];

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly client: EnGenAIClient
  ) {
    // Watch for cross-window secret changes
    this._disposables.push(
      secrets.onDidChange((e) => {
        if (e.key === TOKEN_KEY) {
          this._handleTokenChange();
        }
      })
    );
  }

  get state(): ConnectionState {
    return this._state;
  }

  get user(): UserInfo | undefined {
    return this._user;
  }

  // --- VS Code AuthenticationProvider interface ---

  async getSessions(
    _scopes?: readonly string[]
  ): Promise<vscode.AuthenticationSession[]> {
    const sessionsJson = await this.secrets.get(SESSIONS_KEY);
    if (!sessionsJson) return [];
    try {
      return JSON.parse(sessionsJson);
    } catch {
      return [];
    }
  }

  async createSession(
    scopes: readonly string[]
  ): Promise<vscode.AuthenticationSession> {
    const token = await vscode.window.showInputBox({
      prompt: "Enter your EnGenAI Personal Access Token",
      placeHolder: "eng_live_...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value) return "API key is required";
        if (
          !value.startsWith("eng_live_") &&
          !value.startsWith("eng_test_")
        ) {
          return "Token must start with eng_live_ or eng_test_";
        }
        if (value.length < 40) return "Token appears too short";
        return null;
      },
    });

    if (!token) {
      throw new Error("Sign in cancelled");
    }

    return this._authenticateWithToken(token, [...scopes]);
  }

  async removeSession(sessionId: string): Promise<void> {
    const sessions = await this.getSessions();
    const target = sessions.find((s) => s.id === sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);

    await this.secrets.store(SESSIONS_KEY, JSON.stringify(remaining));
    await this.secrets.delete(TOKEN_KEY);

    this.client.setToken(undefined);
    this._setState("disconnected");
    this._stopHealthCheck();

    if (target) {
      this._onDidChangeSessions.fire({ added: [], removed: [target], changed: [] });
    }
  }

  // --- Public auth methods ---

  /**
   * Try to restore session from stored token on activation.
   */
  async tryRestore(): Promise<boolean> {
    const token = await this.secrets.get(TOKEN_KEY);
    if (!token) return false;

    try {
      this._setState("connecting");
      this.client.setToken(token);
      this._user = await this.client.validateToken();
      this._setState("connected", this._user);
      this._startHealthCheck();
      return true;
    } catch {
      this.client.setToken(undefined);
      this._setState("disconnected");
      return false;
    }
  }

  /**
   * Sign in with a PAT key programmatically (called from webview).
   */
  async signInWithPAT(): Promise<void> {
    await vscode.authentication.getSession(AUTH_TYPE, ["read", "write"], {
      createIfNone: true,
    });
  }

  /**
   * Sign out and clear all credentials.
   */
  async signOut(): Promise<void> {
    const sessions = await this.getSessions();
    for (const session of sessions) {
      await this.removeSession(session.id);
    }
  }

  // --- Internal ---

  private async _authenticateWithToken(
    token: string,
    scopes: string[]
  ): Promise<vscode.AuthenticationSession> {
    this._setState("connecting");
    this.client.setToken(token);

    try {
      const userInfo = await this.client.validateToken();
      this._user = userInfo;

      // Store token securely
      await this.secrets.store(TOKEN_KEY, token);

      // Create session for VS Code Accounts menu
      const session: vscode.AuthenticationSession = {
        id: crypto.randomUUID(),
        accessToken: token,
        account: { id: userInfo.userId, label: userInfo.email },
        scopes,
      };

      await this.secrets.store(SESSIONS_KEY, JSON.stringify([session]));
      this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });

      this._setState("connected", userInfo);
      this._startHealthCheck();

      return session;
    } catch (e) {
      this.client.setToken(undefined);
      if (e instanceof AuthError) {
        this._setState("invalid_key");
        throw new Error("Invalid API key. Please check and try again.");
      }
      this._setState("offline");
      throw e;
    }
  }

  /**
   * Store a token obtained from Device Flow.
   */
  async storeDeviceFlowToken(token: string, userInfo: UserInfo): Promise<void> {
    this._user = userInfo;
    await this.secrets.store(TOKEN_KEY, token);
    this.client.setToken(token);

    const session: vscode.AuthenticationSession = {
      id: crypto.randomUUID(),
      accessToken: token,
      account: { id: userInfo.userId, label: userInfo.email },
      scopes: ["read", "write"],
    };

    await this.secrets.store(SESSIONS_KEY, JSON.stringify([session]));
    this._onDidChangeSessions.fire({ added: [session], removed: [], changed: [] });

    this._setState("connected", userInfo);
    this._startHealthCheck();
  }

  private _setState(state: ConnectionState, user?: UserInfo): void {
    this._state = state;
    if (user) this._user = user;
    this._onDidChangeState.fire({ state, user: this._user });
  }

  private _startHealthCheck(): void {
    this._stopHealthCheck();
    this._healthCheckInterval = setInterval(async () => {
      try {
        await this.client.validateToken();
        if (this._state !== "connected") {
          this._setState("connected", this._user);
        }
      } catch (e) {
        if (e instanceof AuthError) {
          // Key was revoked
          await this.secrets.delete(TOKEN_KEY);
          this.client.setToken(undefined);
          this._setState("invalid_key");
          this._stopHealthCheck();

          const action = await vscode.window.showWarningMessage(
            "Your EnGenAI API key has been revoked.",
            "Sign In Again"
          );
          if (action === "Sign In Again") {
            vscode.commands.executeCommand("engenai.signIn");
          }
        } else {
          this._setState("offline");
        }
      }
    }, 60_000);
  }

  private _stopHealthCheck(): void {
    if (this._healthCheckInterval) {
      clearInterval(this._healthCheckInterval);
      this._healthCheckInterval = undefined;
    }
  }

  private async _handleTokenChange(): Promise<void> {
    const token = await this.secrets.get(TOKEN_KEY);
    if (token && !this.client.isAuthenticated) {
      await this.tryRestore();
    } else if (!token && this.client.isAuthenticated) {
      this.client.setToken(undefined);
      this._setState("disconnected");
    }
  }

  dispose(): void {
    this._stopHealthCheck();
    this._onDidChangeSessions.dispose();
    this._onDidChangeState.dispose();
    this._disposables.forEach((d) => d.dispose());
  }
}

/**
 * Register the auth provider and commands.
 */
export function registerAuth(
  context: vscode.ExtensionContext,
  authManager: AuthManager
): void {
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      AUTH_TYPE,
      AUTH_NAME,
      authManager,
      { supportsMultipleAccounts: false }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("engenai.signIn", () =>
      authManager.signInWithPAT()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("engenai.signOut", () =>
      authManager.signOut()
    )
  );
}
