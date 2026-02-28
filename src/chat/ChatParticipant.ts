import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";

/**
 * @engenai Chat Participant for VS Code Copilot Chat.
 *
 * ONLY available in VS Code (not Cursor, Windsurf, or other forks).
 * Feature-gated at runtime via typeof check on vscode.chat.
 *
 * Commands:
 *   /plan  — route to Keith (CPO) for feature planning
 *   /fix   — route to Sophi (Backend) with code context
 *   /review — route to Sophi for code review
 *   /test  — route to Sophi for test generation
 */
export function registerChatParticipant(
  context: vscode.ExtensionContext,
  client: EnGenAIClient,
  getProjectId: () => string | undefined
): void {
  const participant = vscode.chat.createChatParticipant(
    "engenai",
    async (
      request: vscode.ChatRequest,
      _context: vscode.ChatContext,
      stream: vscode.ChatResponseStream,
      token: vscode.CancellationToken
    ) => {
      const projectId = getProjectId();
      if (!projectId) {
        stream.markdown(
          "Please select an EnGenAI project first. Open the EnGenAI sidebar and choose a project."
        );
        return;
      }

      if (!client.isAuthenticated) {
        stream.markdown(
          "Please sign in to EnGenAI first. Use the command `EnGenAI: Sign In`."
        );
        return;
      }

      // Determine agent and task based on command
      let agent = "keith";
      let taskPrefix = "";

      switch (request.command) {
        case "fix":
          agent = "sophi";
          taskPrefix = "Fix the following issue: ";
          break;
        case "review":
          agent = "sophi";
          taskPrefix = "Review this code: ";
          break;
        case "test":
          agent = "sophi";
          taskPrefix = "Write tests for: ";
          break;
        case "plan":
        default:
          agent = "keith";
          taskPrefix = "Plan: ";
          break;
      }

      // Get editor context if available
      const editor = vscode.window.activeTextEditor;
      let codeContext = "";
      if (editor) {
        const selection = editor.document.getText(editor.selection);
        if (selection.trim()) {
          codeContext = `\n\nCode context from ${vscode.workspace.asRelativePath(editor.document.uri)}:\n\`\`\`${editor.document.languageId}\n${selection}\n\`\`\``;
        }
      }

      const fullTask = `${taskPrefix}${request.prompt}${codeContext}`;

      stream.progress(`Sending to ${agent}...`);

      try {
        const result = await client.triggerAgent(projectId, agent, fullTask);

        if (token.isCancellationRequested) return;

        stream.markdown(
          `**${agent === "keith" ? "Keith (CPO)" : "Sophi (Backend)"}** is working on this.\n\n` +
            `Task ID: \`${result.task_id}\`\n\n` +
            `Check the **EnGenAI sidebar** for the full agent response.`
        );
      } catch (e: unknown) {
        const msg =
          e instanceof Error ? e.message : "Failed to reach agent";
        stream.markdown(`Error: ${msg}`);
      }
    }
  );

  participant.iconPath = vscode.Uri.joinPath(
    context.extensionUri,
    "media",
    "engenai-icon.svg"
  );

  context.subscriptions.push(participant);
}
