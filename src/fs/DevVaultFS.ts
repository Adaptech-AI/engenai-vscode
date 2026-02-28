import * as vscode from "vscode";
import { EnGenAIClient, ApiError } from "../api/EnGenAIClient.js";
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
  // ETag cache: uri → content hash from last read/write. Used for If-Match on writes.
  private etagCache = new Map<string, string>();

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
      const { content, etag } = await this.client.vaultRead(projectId, vaultPath);
      const encoded = new TextEncoder().encode(content);

      // Cache ETag for subsequent writes
      if (etag) {
        this.etagCache.set(key, etag);
      }

      // Cache content keyed by mtime
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
  // FileSystemProvider: Write methods (Sprint 19 Phase I)
  // ──────────────────────────────────────────

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const { projectId, vaultPath } = this.parseUri(uri);
    const key = uri.toString();
    const text = new TextDecoder().decode(content);

    // Use cached ETag for conditional write (If-Match: {hash}).
    // First-time write: no ETag → no If-Match header (unconditional create).
    const ifMatch = this.etagCache.get(key);

    try {
      const result = await this.client.vaultWrite(
        projectId,
        vaultPath,
        text,
        ifMatch
      );
      this.etagCache.set(key, result.etag);
      this.invalidateCache(uri);
      this._fireSoon({
        type: options.create
          ? vscode.FileChangeType.Created
          : vscode.FileChangeType.Changed,
        uri,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        await this._handleConflict(uri, projectId, vaultPath, text);
      } else if (err instanceof ApiError && err.status === 404) {
        throw vscode.FileSystemError.FileNotFound(uri);
      } else {
        throw vscode.FileSystemError.Unavailable(uri);
      }
    }
  }

  async delete(
    uri: vscode.Uri,
    _options: { recursive: boolean }
  ): Promise<void> {
    const { projectId, vaultPath } = this.parseUri(uri);

    try {
      await this.client.vaultDelete(projectId, vaultPath);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
      throw vscode.FileSystemError.Unavailable(uri);
    }

    this.etagCache.delete(uri.toString());
    this.invalidateCache(uri);
    this._fireSoon({ type: vscode.FileChangeType.Deleted, uri });
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    _options: { overwrite: boolean }
  ): Promise<void> {
    const { projectId, vaultPath: fromPath } = this.parseUri(oldUri);
    const { vaultPath: toPath } = this.parseUri(newUri);

    try {
      const result = await this.client.vaultRename(projectId, fromPath, toPath);
      // Transfer ETag to the new path
      if (result.etag) {
        this.etagCache.set(newUri.toString(), result.etag);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        throw vscode.FileSystemError.FileNotFound(oldUri);
      }
      if (err instanceof ApiError && err.status === 409) {
        throw vscode.FileSystemError.FileExists(newUri);
      }
      throw vscode.FileSystemError.Unavailable(oldUri);
    }

    this.etagCache.delete(oldUri.toString());
    this.invalidateCache(oldUri);
    this.invalidateCache(newUri);
    this._fireSoon(
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri }
    );
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { projectId, vaultPath } = this.parseUri(uri);

    try {
      await this.client.vaultMkdir(projectId, vaultPath);
    } catch (err) {
      throw vscode.FileSystemError.Unavailable(uri);
    }

    this.invalidateCache(uri);
    this._fireSoon({ type: vscode.FileChangeType.Created, uri });
  }

  // ──────────────────────────────────────────
  // Conflict resolution (409 ETag mismatch)
  // ──────────────────────────────────────────

  private async _handleConflict(
    uri: vscode.Uri,
    projectId: string,
    vaultPath: string,
    localContent: string
  ): Promise<void> {
    const fileName = uri.path.split("/").pop() ?? "file";
    const choice = await vscode.window.showWarningMessage(
      `"${fileName}" was modified by another client while you were editing. What would you like to do?`,
      { modal: true },
      "Upload Anyway",
      "Discard Local Changes"
    );

    if (choice === "Upload Anyway") {
      // Unconditional overwrite
      const result = await this.client.vaultWrite(
        projectId,
        vaultPath,
        localContent,
        "*"
      );
      this.etagCache.set(uri.toString(), result.etag);
      this.invalidateCache(uri);
      this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
    } else {
      // Discard local — evict cache so VS Code re-reads from vault
      this.etagCache.delete(uri.toString());
      this.invalidateCache(uri);
      this._fireSoon({ type: vscode.FileChangeType.Changed, uri });
      throw vscode.FileSystemError.Unavailable(
        "Local changes discarded. The file will reload from the vault."
      );
    }
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
    this.etagCache.clear();
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
    })
  );

  context.subscriptions.push(devVaultFS);

  return devVaultFS;
}
