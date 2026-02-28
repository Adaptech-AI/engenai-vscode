import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";
import { SSEClient } from "../streaming/SSEClient.js";

/**
 * FileSystemProvider that mounts the EnGenAI Dev-Vault as a read-only
 * virtual folder in VS Code Explorer.
 *
 * Sprint 17: Read-only. Write methods throw NoPermissions.
 * Sprint 19: Read-write with ETag conflict detection.
 *
 * Caching strategy (three-tier):
 *   - stat cache: 30s TTL, invalidated on SSE file change event
 *   - directory cache: 30s TTL, invalidated on SSE create/delete
 *   - file content cache: keyed by uri+mtime, evicted on change
 *
 * Real-time updates:
 *   - SSE subscription to vault activity stream
 *   - Maps server events → FileChangeEvent (Created/Changed/Deleted)
 *   - 5ms debounce window (MemFS pattern) for batch refreshes
 */
export class DevVaultFS implements vscode.FileSystemProvider {
  // --- Event system ---
  private _emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> =
    this._emitter.event;

  // --- Caches ---
  private statCache = new Map<
    string,
    { stat: vscode.FileStat; expires: number }
  >();
  private dirCache = new Map<
    string,
    { entries: [string, vscode.FileType][]; expires: number }
  >();
  private fileCache = new Map<
    string,
    { content: Uint8Array; mtime: number }
  >();

  private readonly STAT_TTL = 30_000;
  private readonly DIR_TTL = 30_000;

  // --- Event batching (5ms debounce, matches MemFS sample) ---
  private _bufferedEvents: vscode.FileChangeEvent[] = [];
  private _fireSoonHandle?: ReturnType<typeof setTimeout>;

  // --- SSE for real-time updates ---
  private sseClient = new SSEClient();
  private currentProjectId: string | undefined;

  constructor(private readonly client: EnGenAIClient) {}

  // ──────────────────────────────────────────
  // FileSystemProvider: Required read methods
  // ──────────────────────────────────────────

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const key = uri.toString();
    const cached = this.statCache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.stat;
    }

    const { projectId, vaultPath } = this.parseUri(uri);

    // Root directory
    if (vaultPath === "/" || vaultPath === "") {
      const rootStat: vscode.FileStat = {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
      this.statCache.set(key, {
        stat: rootStat,
        expires: Date.now() + this.STAT_TTL,
      });
      return rootStat;
    }

    try {
      const response = await this.client.vaultStat(projectId, vaultPath);
      const stat: vscode.FileStat = {
        type: response.is_directory
          ? vscode.FileType.Directory
          : vscode.FileType.File,
        ctime: response.created_at_ms,
        mtime: response.modified_at_ms,
        size: response.size_bytes,
        permissions: vscode.FilePermission.Readonly,
      };

      this.statCache.set(key, {
        stat,
        expires: Date.now() + this.STAT_TTL,
      });
      return stat;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readDirectory(
    uri: vscode.Uri
  ): Promise<[string, vscode.FileType][]> {
    const key = uri.toString();
    const cached = this.dirCache.get(key);
    if (cached && Date.now() < cached.expires) {
      return cached.entries;
    }

    const { projectId, vaultPath } = this.parseUri(uri);

    try {
      const entries = await this.client.vaultList(projectId, vaultPath);
      const result: [string, vscode.FileType][] = entries.map((e) => [
        e.name,
        e.is_directory ? vscode.FileType.Directory : vscode.FileType.File,
      ]);

      this.dirCache.set(key, {
        entries: result,
        expires: Date.now() + this.DIR_TTL,
      });
      return result;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const key = uri.toString();

    // Check content cache by mtime
    const cachedContent = this.fileCache.get(key);
    if (cachedContent) {
      const stat = this.statCache.get(key);
      if (stat && stat.stat.mtime === cachedContent.mtime) {
        return cachedContent.content;
      }
    }

    const { projectId, vaultPath } = this.parseUri(uri);

    try {
      const content = await this.client.vaultRead(projectId, vaultPath);
      const encoded = new TextEncoder().encode(content);

      // Cache with current mtime
      const stat = this.statCache.get(key);
      if (stat) {
        this.fileCache.set(key, {
          content: encoded,
          mtime: stat.stat.mtime,
        });
      }

      return encoded;
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  // ──────────────────────────────────────────
  // FileSystemProvider: Write methods (Sprint 17: read-only)
  // ──────────────────────────────────────────

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions(
      "Dev-Vault is read-only in this version. Agents create and edit files."
    );
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions(
      "Dev-Vault is read-only in this version."
    );
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions(
      "Dev-Vault is read-only in this version."
    );
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions(
      "Dev-Vault is read-only in this version."
    );
  }

  // ──────────────────────────────────────────
  // FileSystemProvider: Watch (no-op — SSE handles all changes)
  // ──────────────────────────────────────────

  watch(): vscode.Disposable {
    // SSE subscription fires events globally — no per-path watching needed
    return new vscode.Disposable(() => {});
  }

  // ──────────────────────────────────────────
  // Mount / Unmount
  // ──────────────────────────────────────────

  /**
   * Mount a project's dev-vault as a workspace folder in Explorer.
   */
  mountProject(projectId: string, projectName: string): void {
    this.currentProjectId = projectId;

    // Add virtual folder to workspace
    const uri = vscode.Uri.parse(`engenai://project-${projectId}/vault`);
    const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;

    vscode.workspace.updateWorkspaceFolders(folderCount, null, {
      uri,
      name: `EnGenAI: ${projectName}`,
    });

    // Start SSE for real-time file change notifications
    this.startActivityStream(projectId);
  }

  /**
   * Unmount the current project's dev-vault.
   */
  unmountProject(): void {
    this.sseClient.disconnect();
    this.clearAllCaches();

    // Find and remove the EnGenAI workspace folder
    const folders = vscode.workspace.workspaceFolders;
    if (folders) {
      const idx = folders.findIndex((f) => f.uri.scheme === "engenai");
      if (idx >= 0) {
        vscode.workspace.updateWorkspaceFolders(idx, 1);
      }
    }

    this.currentProjectId = undefined;
  }

  // ──────────────────────────────────────────
  // Real-time file change notifications (SSE)
  // ──────────────────────────────────────────

  private startActivityStream(projectId: string): void {
    const token = this.client.isAuthenticated ? "active" : "";
    if (!token) return;

    this.sseClient.connect({
      url: `${this.client.apiUrl}/api/v1/projects/${projectId}/vault/stream`,
      token,
      onMessage: (event) => {
        try {
          const data = JSON.parse(event.data) as {
            path: string;
            action: "created" | "updated" | "deleted";
            agent_id?: string;
          };
          this.handleRemoteFileChange(projectId, data);
        } catch {
          // Non-JSON events — ignore
        }
      },
      onError: () => {
        // Auth failed or connection lost — SSEClient handles retry
      },
    });
  }

  private handleRemoteFileChange(
    projectId: string,
    data: { path: string; action: string }
  ): void {
    const uri = vscode.Uri.parse(
      `engenai://project-${projectId}/vault${data.path}`
    );

    // Invalidate caches for this path
    this.invalidateCache(uri);

    // Map action → FileChangeType
    let changeType: vscode.FileChangeType;
    switch (data.action) {
      case "created":
        changeType = vscode.FileChangeType.Created;
        break;
      case "deleted":
        changeType = vscode.FileChangeType.Deleted;
        break;
      default:
        changeType = vscode.FileChangeType.Changed;
    }

    // Fire with debounce
    this._fireSoon({ type: changeType, uri });
  }

  // ──────────────────────────────────────────
  // Cache management
  // ──────────────────────────────────────────

  private invalidateCache(uri: vscode.Uri): void {
    const key = uri.toString();
    this.statCache.delete(key);
    this.fileCache.delete(key);

    // Also invalidate parent directory listing
    const parentPath = uri.path.substring(0, uri.path.lastIndexOf("/")) || "/";
    const parentUri = uri.with({ path: parentPath });
    this.dirCache.delete(parentUri.toString());
  }

  private clearAllCaches(): void {
    this.statCache.clear();
    this.dirCache.clear();
    this.fileCache.clear();
  }

  // ──────────────────────────────────────────
  // Event debouncing (5ms window — MemFS pattern)
  // ──────────────────────────────────────────

  private _fireSoon(...events: vscode.FileChangeEvent[]): void {
    this._bufferedEvents.push(...events);

    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }

    this._fireSoonHandle = setTimeout(() => {
      this._emitter.fire(this._bufferedEvents);
      this._bufferedEvents = [];
    }, 5);
  }

  // ──────────────────────────────────────────
  // URI parsing
  // ──────────────────────────────────────────

  private parseUri(uri: vscode.Uri): {
    projectId: string;
    vaultPath: string;
  } {
    // URI format: engenai://project-{id}/vault/{path}
    const projectId = uri.authority.replace("project-", "");
    const vaultPath = uri.path.replace(/^\/vault/, "") || "/";
    return { projectId, vaultPath };
  }

  // ──────────────────────────────────────────
  // Disposal
  // ──────────────────────────────────────────

  dispose(): void {
    this.sseClient.disconnect();
    this._emitter.dispose();
    this.clearAllCaches();
    if (this._fireSoonHandle) {
      clearTimeout(this._fireSoonHandle);
    }
  }
}

/**
 * Register the FileSystemProvider and return the instance.
 */
export function registerDevVaultFS(
  context: vscode.ExtensionContext,
  client: EnGenAIClient
): DevVaultFS {
  const devVaultFS = new DevVaultFS(client);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider("engenai", devVaultFS, {
      isCaseSensitive: true,
      isReadonly: new vscode.MarkdownString(
        "EnGenAI Dev-Vault is currently **read-only**. Files are created and edited by EnGenAI agents. Read-write support coming in a future update."
      ),
    })
  );

  context.subscriptions.push(devVaultFS);

  return devVaultFS;
}
