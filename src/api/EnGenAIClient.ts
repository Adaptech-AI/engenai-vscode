import * as vscode from "vscode";
import type { Project, UserInfo, AgentMessage } from "../types/protocol.js";

/**
 * HTTP client for all EnGenAI backend endpoints.
 * All API calls go through this client — the webview never calls the API directly.
 */
export class EnGenAIClient {
  private baseUrl: string;
  private token: string | undefined;
  private readonly extensionVersion: string;

  constructor(extensionVersion = "0.1.2") {
    this.extensionVersion = extensionVersion;
    const config = vscode.workspace.getConfiguration("engenai");
    this.baseUrl = config.get<string>("serverUrl", "https://dev.engenai.app");

    // Watch for config changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("engenai.serverUrl")) {
        this.baseUrl = vscode.workspace
          .getConfiguration("engenai")
          .get<string>("serverUrl", "https://dev.engenai.app");
      }
    });
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  get isAuthenticated(): boolean {
    return !!this.token;
  }

  get apiUrl(): string {
    return this.baseUrl;
  }

  // --- Auth ---

  async validateToken(): Promise<UserInfo> {
    const res = await this.fetch("/api/v1/auth/me");
    return (await res.json()) as UserInfo;
  }

  async requestDeviceCode(): Promise<{
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  }> {
    const res = await this.fetch("/api/v1/auth/device", {
      method: "POST",
      body: JSON.stringify({
        client_id: "engenai-vscode",
        scope: "read write agents",
      }),
    });
    return (await res.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
  }

  async exchangeOAuthCode(
    code: string,
    codeVerifier: string,
    redirectUri: string
  ): Promise<{ access_token: string; refresh_token: string; expires_in: number; user_info: UserInfo }> {
    const res = await this.fetchRaw("/api/v1/oauth/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        client_id: "engenai-vscode",
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { detail?: string };
      throw new Error(err.detail ?? `OAuth token exchange failed (${res.status})`);
    }

    return (await res.json()) as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      user_info: UserInfo;
    };
  }

  async pollDeviceToken(
    deviceCode: string
  ): Promise<{ access_token: string; user_info: UserInfo } | null> {
    const res = await this.fetchRaw("/api/v1/auth/device/token", {
      method: "POST",
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: "engenai-vscode",
      }),
    });

    if (res.ok) {
      return (await res.json()) as { access_token: string; user_info: UserInfo };
    }

    const error = (await res.json()) as { error?: string };
    if (
      error.error === "authorization_pending" ||
      error.error === "slow_down"
    ) {
      return null; // Keep polling
    }

    throw new Error(error.error || "Device flow failed");
  }

  // --- Projects ---

  async listProjects(): Promise<Project[]> {
    const res = await this.fetch("/api/v1/projects");
    const data = (await res.json()) as { projects?: Project[] } | Project[];
    return Array.isArray(data) ? data : (data.projects ?? []);
  }

  // --- Agent Messages ---

  async getAgentMessages(
    projectId: string,
    limit = 50
  ): Promise<AgentMessage[]> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/messages?limit=${limit}`
    );
    return (await res.json()) as AgentMessage[];
  }

  async triggerAgent(
    projectId: string,
    agentName: string,
    task: string
  ): Promise<{ task_id: string }> {
    const res = await this.fetch("/api/v1/mcp", {
      method: "POST",
      body: JSON.stringify({
        tool: "trigger_agent",
        arguments: { project_id: projectId, agent_name: agentName, task },
      }),
    });
    return (await res.json()) as { task_id: string };
  }

  // --- Dev-Vault ---

  async vaultList(
    projectId: string,
    path: string
  ): Promise<Array<{ name: string; is_directory: boolean }>> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/ls?path=${encodeURIComponent(path)}`
    );
    return (await res.json()) as Array<{ name: string; is_directory: boolean }>;
  }

  async vaultStat(
    projectId: string,
    path: string
  ): Promise<{
    is_directory: boolean;
    size_bytes: number;
    created_at_ms: number;
    modified_at_ms: number;
  }> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/stat?path=${encodeURIComponent(path)}`
    );
    return (await res.json()) as {
      is_directory: boolean;
      size_bytes: number;
      created_at_ms: number;
      modified_at_ms: number;
    };
  }

  async vaultRead(
    projectId: string,
    path: string
  ): Promise<{ content: string; etag: string }> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/read?path=${encodeURIComponent(path)}`
    );
    const data = (await res.json()) as { content: string; etag: string };
    return data;
  }

  async vaultWrite(
    projectId: string,
    path: string,
    content: string,
    ifMatch?: string
  ): Promise<{ etag: string; action: string; size_bytes: number }> {
    const headers: Record<string, string> = {};
    if (ifMatch !== undefined) {
      headers["If-Match"] = ifMatch;
    }
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/write?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ content }),
      }
    );
    return (await res.json()) as { etag: string; action: string; size_bytes: number };
  }

  async vaultDelete(projectId: string, path: string): Promise<void> {
    await this.fetch(
      `/api/v1/projects/${projectId}/vault/delete?path=${encodeURIComponent(path)}`,
      { method: "DELETE" }
    );
  }

  async vaultRename(
    projectId: string,
    fromPath: string,
    toPath: string
  ): Promise<{ from: string; to: string; etag: string }> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/rename`,
      {
        method: "POST",
        body: JSON.stringify({ from_path: fromPath, to_path: toPath }),
      }
    );
    return (await res.json()) as { from: string; to: string; etag: string };
  }

  async vaultMkdir(
    projectId: string,
    path: string
  ): Promise<{ path: string; placeholder: string }> {
    const res = await this.fetch(
      `/api/v1/projects/${projectId}/vault/mkdir`,
      {
        method: "POST",
        body: JSON.stringify({ path }),
      }
    );
    return (await res.json()) as { path: string; placeholder: string };
  }

  // --- Context Pipeline ---

  async submitContext(payload: {
    project_id: string;
    file_path: string;
    file_hash: string;
    language: string;
    selection: string;
    selection_range: { start: number; end: number };
    surrounding_lines: string;
    imports: string;
  }): Promise<{ needs_upload: boolean; upload_url?: string; task_id?: string }> {
    const res = await this.fetch("/api/v1/context/submit", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return (await res.json()) as { needs_upload: boolean; upload_url?: string; task_id?: string };
  }

  async uploadFile(uploadUrl: string, content: string): Promise<void> {
    await this.fetchRaw(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: content,
    });
  }

  // --- Internal fetch helpers ---

  private async fetch(path: string, options: RequestInit = {}): Promise<Response> {
    const res = await this.fetchRaw(path, options);

    if (res.status === 401) {
      throw new AuthError("Invalid or expired API key");
    }
    if (res.status === 402) {
      throw new CreditsError("Credits exhausted");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "Unknown error");
      throw new ApiError(`API error ${res.status}: ${text}`, res.status);
    }

    return res;
  }

  private async fetchRaw(
    path: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Client identification — helps backend distinguish extension traffic from web UI
      // and enables per-version deprecation warnings without breaking old clients.
      "X-EnGenAI-Client": "vscode-extension",
      "X-EnGenAI-Version": this.extensionVersion,
      ...(options.headers as Record<string, string>),
    };

    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    return fetch(url, {
      ...options,
      headers,
      signal: options.signal ?? AbortSignal.timeout(30_000),
    });
  }
}

// --- Error types ---

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export class CreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreditsError";
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}
