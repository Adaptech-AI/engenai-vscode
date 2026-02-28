import { create } from "zustand";
import type {
  AgentMessage,
  ConnectionState,
  Project,
  UserInfo,
  AgentId,
  ExtensionToWebview,
} from "../../../src/types/protocol";
import { postMessage } from "../hooks/useVSCode";

interface AppState {
  // Connection
  connectionState: ConnectionState;
  user: UserInfo | null;

  // Projects
  projects: Project[];
  selectedProjectId: string | null;

  // Chat
  messages: AgentMessage[];
  streamingContent: Record<string, string>; // agentId -> partial content

  // Actions
  signIn: () => void;
  signInWithBrowser: () => void;
  signOut: () => void;
  selectProject: (projectId: string) => void;
  deselectProject: () => void;
  sendMessage: (text: string, targetAgent?: AgentId) => void;
  handleExtensionMessage: (msg: ExtensionToWebview) => void;
}

export const useAppStore = create<AppState>((set, _get) => ({
  connectionState: "disconnected",
  user: null,
  projects: [],
  selectedProjectId: null,
  messages: [],
  streamingContent: {},

  signIn: () => postMessage({ type: "signIn" }),
  signInWithBrowser: () => postMessage({ type: "signInWithBrowser" }),
  signOut: () => {
    postMessage({ type: "signOut" });
    set({ messages: [], selectedProjectId: null, projects: [] });
  },

  selectProject: (projectId: string) => {
    postMessage({ type: "selectProject", projectId });
    set({ selectedProjectId: projectId, messages: [] });
  },

  deselectProject: () => {
    postMessage({ type: "deselectProject" });
    set({ selectedProjectId: null, messages: [] });
  },

  sendMessage: (text: string, targetAgent?: AgentId) => {
    postMessage({ type: "sendMessage", text, targetAgent });
  },

  handleExtensionMessage: (msg: ExtensionToWebview) => {
    switch (msg.type) {
      case "connectionState":
        set({
          connectionState: msg.state,
          user: msg.user ?? null,
        });
        break;

      case "projects":
        set({ projects: msg.projects });
        break;

      case "agentMessage":
        set((state) => ({
          messages: [...state.messages, msg.message],
          // Clear streaming content for this agent when full message arrives
          streamingContent: {
            ...state.streamingContent,
            [msg.message.agentId]: "",
          },
        }));
        break;

      case "streamToken":
        set((state) => ({
          streamingContent: {
            ...state.streamingContent,
            [msg.agentId]:
              (state.streamingContent[msg.agentId] ?? "") + msg.content,
          },
        }));
        break;

      case "streamEnd":
        set((state) => ({
          streamingContent: {
            ...state.streamingContent,
            [msg.agentId]: "",
          },
        }));
        break;

      case "error":
        console.error("[EnGenAI]", msg.message);
        break;
    }
  },
}));

// Listen for messages from extension host
if (typeof window !== "undefined") {
  window.addEventListener("message", (event) => {
    const msg = event.data as ExtensionToWebview;
    if (msg?.type) {
      useAppStore.getState().handleExtensionMessage(msg);
    }
  });
}
