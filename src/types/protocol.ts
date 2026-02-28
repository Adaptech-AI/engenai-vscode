/**
 * Typed postMessage protocol between extension host and webview.
 *
 * Extension host sends: ExtensionToWebview messages
 * Webview sends: WebviewToExtension messages
 *
 * The webview NEVER receives raw tokens or secrets — the extension host
 * makes all authenticated API calls and sends results.
 */

// --- Agent Types ---

export type AgentId = "keith" | "sophi" | "marv" | "promi" | "sage";

export interface AgentInfo {
  id: AgentId;
  name: string;
  role: string;
  color: string;
}

export const AGENTS: Record<AgentId, AgentInfo> = {
  keith: { id: "keith", name: "Keith", role: "CPO", color: "#22C55E" },
  sophi: { id: "sophi", name: "Sophi", role: "Backend", color: "#A855F7" },
  marv: { id: "marv", name: "Marv", role: "Frontend", color: "#3B82F6" },
  promi: { id: "promi", name: "PROMI", role: "Orchestrator", color: "#F97316" },
  sage: { id: "sage", name: "Sage", role: "Knowledge", color: "#EAB308" },
};

// --- Project Types ---

export interface Project {
  id: string;
  name: string;
  description?: string;
}

// --- Chat Message Types ---

export interface AgentMessage {
  id: string;
  agentId: AgentId;
  content: string;
  timestamp: string;
  type: "text" | "file_change" | "delegation" | "status";
  metadata?: {
    filePath?: string;
    fileAction?: "created" | "modified" | "deleted";
    delegateTo?: AgentId;
    delegateTask?: string;
  };
}

// --- Connection State ---

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "invalid_key"
  | "offline";

export interface UserInfo {
  userId: string;
  email: string;
  orgId: string;
  orgName: string;
}

// --- Extension → Webview Messages ---

export type ExtensionToWebview =
  | { type: "connectionState"; state: ConnectionState; user?: UserInfo }
  | { type: "projects"; projects: Project[] }
  | { type: "agentMessage"; message: AgentMessage }
  | { type: "streamToken"; agentId: AgentId; content: string }
  | { type: "streamEnd"; agentId: AgentId }
  | { type: "fileChange"; projectId: string; path: string; action: "created" | "modified" | "deleted"; agentId: AgentId }
  | { type: "error"; message: string };

// --- Webview → Extension Messages ---

export type WebviewToExtension =
  | { type: "signIn" }
  | { type: "signInWithBrowser" }
  | { type: "signOut" }
  | { type: "selectProject"; projectId: string }
  | { type: "deselectProject" }
  | { type: "sendMessage"; text: string; targetAgent?: AgentId }
  | { type: "openFile"; uri: string }
  | { type: "ready" };
