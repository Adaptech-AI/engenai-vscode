import { AGENTS, type AgentId } from "../../../src/types/protocol";

interface AgentBadgeProps {
  agentId: AgentId;
  showRole?: boolean;
  size?: "sm" | "md";
}

export function AgentBadge({ agentId, showRole = false, size = "md" }: AgentBadgeProps) {
  const agent = AGENTS[agentId];
  if (!agent) return null;

  const dotSize = size === "sm" ? "w-2 h-2" : "w-2.5 h-2.5";
  const textSize = size === "sm" ? "text-xs" : "text-sm";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`${dotSize} rounded-full inline-block flex-shrink-0`}
        style={{ backgroundColor: agent.color }}
      />
      <span className={`${textSize} font-medium`} style={{ color: agent.color }}>
        {agent.name}
      </span>
      {showRole && (
        <span className={`${textSize} opacity-60`}>({agent.role})</span>
      )}
    </span>
  );
}
