import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { useAppStore } from "../store";
import { AgentBadge } from "./AgentBadge";
import { AGENTS, type AgentId, type AgentMessage } from "../../../src/types/protocol";
import { postMessage } from "../hooks/useVSCode";

export function AgentChat() {
  const { messages, streamingContent, selectedProjectId } = useAppStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent]);

  if (!selectedProjectId) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 text-xs opacity-50 text-center">
        Select a project above to see agent conversations
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-4 gap-2">
        <div className="flex gap-2">
          {(["keith", "sophi", "marv", "promi"] as AgentId[]).map((id) => (
            <AgentBadge key={id} agentId={id} size="sm" />
          ))}
        </div>
        <p className="text-xs opacity-50 text-center mt-2">
          No messages yet. Send a message to get started.
        </p>
      </div>
    );
  }

  // Collect active streaming agents
  const activeStreams = Object.entries(streamingContent).filter(
    ([, content]) => content.length > 0
  );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {messages.map((msg) => (
        <ChatMessage key={msg.id} message={msg} />
      ))}

      {/* Streaming indicators */}
      {activeStreams.map(([agentId, content]) => (
        <div key={`stream-${agentId}`} className="px-3 py-2 border-b border-input-border opacity-80">
          <div className="flex items-center justify-between mb-1">
            <AgentBadge agentId={agentId as AgentId} showRole />
            <span className="text-[10px] opacity-40 animate-pulse">typing...</span>
          </div>
          <div className="text-xs leading-relaxed pl-4 prose-invert max-w-none">
            <ReactMarkdown>{content}</ReactMarkdown>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChatMessage({ message }: { message: AgentMessage }) {
  if (message.type === "file_change") {
    return <FileChangeMessage message={message} />;
  }

  if (message.type === "delegation") {
    return <DelegationMessage message={message} />;
  }

  const time = new Date(message.timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="px-3 py-2 border-b border-input-border hover:bg-[var(--vscode-list-hoverBackground)]">
      <div className="flex items-center justify-between mb-1">
        <AgentBadge agentId={message.agentId} showRole />
        <span className="text-[10px] opacity-40">{time}</span>
      </div>
      <div className="text-xs leading-relaxed pl-4 prose-invert max-w-none">
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
    </div>
  );
}

function FileChangeMessage({ message }: { message: AgentMessage }) {
  const { filePath, fileAction } = message.metadata ?? {};
  const icon = fileAction === "created" ? "+" : fileAction === "deleted" ? "-" : "~";
  const color = fileAction === "created" ? "text-green-400" : fileAction === "deleted" ? "text-red-400" : "text-yellow-400";

  const handleClick = () => {
    if (filePath) {
      postMessage({ type: "openFile", uri: filePath });
    }
  };

  return (
    <div className="px-3 py-1.5 border-b border-input-border">
      <div className="flex items-center gap-2 text-xs">
        <AgentBadge agentId={message.agentId} size="sm" />
        <span className={color}>{icon}</span>
        <button
          onClick={handleClick}
          className="text-[var(--vscode-textLink-foreground)] hover:underline cursor-pointer bg-transparent border-none p-0 text-xs"
        >
          {filePath}
        </button>
      </div>
    </div>
  );
}

function DelegationMessage({ message }: { message: AgentMessage }) {
  const { delegateTo, delegateTask } = message.metadata ?? {};
  const targetAgent = delegateTo ? AGENTS[delegateTo] : null;

  return (
    <div className="px-3 py-2 border-b border-input-border">
      <div className="mx-2 my-1 px-3 py-2 rounded border border-input-border bg-[var(--vscode-editor-background)]">
        <div className="flex items-center gap-1.5 text-xs mb-1">
          <AgentBadge agentId={message.agentId} size="sm" />
          <span className="opacity-50">→</span>
          {targetAgent && <AgentBadge agentId={delegateTo!} size="sm" />}
        </div>
        <p className="text-xs opacity-70 pl-4">{delegateTask ?? message.content}</p>
      </div>
    </div>
  );
}
