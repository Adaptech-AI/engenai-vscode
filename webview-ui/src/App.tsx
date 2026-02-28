import { useEffect } from "react";
import { useAppStore } from "./store";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { ProjectSelector } from "./components/ProjectSelector";
import { AgentChat } from "./components/AgentChat";
import { MessageInput } from "./components/MessageInput";
import { postMessage } from "./hooks/useVSCode";

export default function App() {
  const { connectionState } = useAppStore();
  const isConnected = connectionState === "connected";

  // Signal ready to extension host
  useEffect(() => {
    postMessage({ type: "ready" });
  }, []);

  return (
    <div className="h-screen flex flex-col text-foreground bg-background font-vscode text-vscode">
      {/* Connection status / sign-in */}
      <ConnectionStatus />

      {/* Project selector (only when connected) */}
      {isConnected && <ProjectSelector />}

      {/* Chat area */}
      <AgentChat />

      {/* Message input */}
      <MessageInput />
    </div>
  );
}
