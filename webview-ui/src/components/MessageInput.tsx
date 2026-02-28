import { useState, useRef, useCallback, type KeyboardEvent } from "react";
import { useAppStore } from "../store";
import type { AgentId } from "../../../src/types/protocol";

export function MessageInput() {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sendMessage, selectedProjectId, connectionState } = useAppStore();

  const disabled = connectionState !== "connected" || !selectedProjectId;

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;

    // Parse @agent mentions: "@Keith plan auth" -> targetAgent=keith, text="plan auth"
    let targetAgent: AgentId | undefined;
    const mentionMatch = trimmed.match(/^@(\w+)\s+(.*)/s);
    if (mentionMatch) {
      const agentName = mentionMatch[1].toLowerCase();
      if (["keith", "sophi", "marv", "promi", "sage"].includes(agentName)) {
        targetAgent = agentName as AgentId;
      }
    }

    sendMessage(trimmed, targetAgent);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, disabled, sendMessage]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
    }
  };

  return (
    <div className="p-2 border-t border-input-border">
      <div className="flex gap-1.5">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => { setText(e.target.value); handleInput(); }}
          onKeyDown={handleKeyDown}
          placeholder={disabled ? "Select a project to chat..." : "Message @Keith, @Sophi..."}
          disabled={disabled}
          rows={1}
          className="flex-1 px-2 py-1.5 text-xs rounded bg-input-bg text-input-fg border border-input-border focus:border-focus-border outline-none resize-none disabled:opacity-50"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          className="px-2 py-1.5 text-xs rounded bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-40 flex-shrink-0"
        >
          Send
        </button>
      </div>
      {!disabled && (
        <div className="mt-1 text-[10px] opacity-40">
          @Keith /plan · @Sophi /fix · Enter to send · Shift+Enter for new line
        </div>
      )}
    </div>
  );
}
