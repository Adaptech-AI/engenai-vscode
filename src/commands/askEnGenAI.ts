import * as vscode from "vscode";
import * as crypto from "crypto";
import { EnGenAIClient } from "../api/EnGenAIClient.js";

/**
 * "Ask EnGenAI" command — captures code context and sends to the platform.
 *
 * Three-layer context strategy:
 *   Layer 1 (free): selection + surrounding ±30 lines + imports
 *   Layer 2 (cheap): Sage indexes file via tree-sitter + Gemini Flash ($0.004/file)
 *   Layer 3 (on demand): full file when agent requests it
 *
 * This command captures Layer 1 and sends it to the backend.
 * If the file hasn't been indexed, the backend requests an upload (Layer 2).
 */
export function registerAskEnGenAI(
  context: vscode.ExtensionContext,
  client: EnGenAIClient,
  getProjectId: () => string | undefined
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("engenai.askEnGenAI", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage("No active editor");
        return;
      }

      const projectId = getProjectId();
      if (!projectId) {
        vscode.window.showWarningMessage(
          "Select an EnGenAI project first"
        );
        return;
      }

      // --- Capture context (Layer 1 — free) ---
      const document = editor.document;
      const selection = editor.selection;
      const selectedText = document.getText(selection);

      if (!selectedText.trim()) {
        vscode.window.showWarningMessage(
          "Select some code first, then use Ask EnGenAI"
        );
        return;
      }

      // Get surrounding ±30 lines
      const startLine = Math.max(0, selection.start.line - 30);
      const endLine = Math.min(
        document.lineCount - 1,
        selection.end.line + 30
      );
      const surroundingRange = new vscode.Range(
        startLine,
        0,
        endLine,
        document.lineAt(endLine).text.length
      );
      const surroundingLines = document.getText(surroundingRange);

      // Extract imports (first 50 lines or until first non-import line)
      const fullText = document.getText();
      const lines = fullText.split("\n");
      const importLines: string[] = [];
      for (let i = 0; i < Math.min(50, lines.length); i++) {
        const line = lines[i].trim();
        if (
          line.startsWith("import ") ||
          line.startsWith("from ") ||
          line.startsWith("require(") ||
          line.startsWith("#include") ||
          line.startsWith("using ") ||
          line.startsWith("package ") ||
          line === "" ||
          line.startsWith("//") ||
          line.startsWith("#")
        ) {
          importLines.push(lines[i]);
        } else if (importLines.length > 0) {
          break; // Past the import section
        }
      }

      // File hash for index check
      const fileHash = crypto
        .createHash("sha256")
        .update(fullText)
        .digest("hex");

      // --- Ask user what to do ---
      const action = await vscode.window.showQuickPick(
        [
          {
            label: "$(sparkle) Ask Keith to plan",
            description: "/plan",
            detail: "Keith will plan how to address this code",
            agent: "keith",
            command: "plan",
          },
          {
            label: "$(wrench) Ask Sophi to fix",
            description: "/fix",
            detail: "Sophi will fix issues in this code",
            agent: "sophi",
            command: "fix",
          },
          {
            label: "$(eye) Ask Sophi to review",
            description: "/review",
            detail: "Sophi will review this code for quality",
            agent: "sophi",
            command: "review",
          },
          {
            label: "$(beaker) Ask Sophi to test",
            description: "/test",
            detail: "Sophi will generate tests for this code",
            agent: "sophi",
            command: "test",
          },
        ],
        { placeHolder: "What should EnGenAI do with this code?" }
      );

      if (!action) return;

      // --- Send to platform ---
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Sending to ${action.agent}...`,
        },
        async () => {
          try {
            const result = await client.submitContext({
              project_id: projectId,
              file_path: vscode.workspace.asRelativePath(document.uri),
              file_hash: fileHash,
              language: document.languageId,
              selection: selectedText,
              selection_range: {
                start: selection.start.line,
                end: selection.end.line,
              },
              surrounding_lines: surroundingLines,
              imports: importLines.join("\n"),
            });

            // If file needs indexing, upload it
            if (result.needs_upload && result.upload_url) {
              await client.uploadFile(result.upload_url, fullText);
            }

            vscode.window.showInformationMessage(
              `Sent to ${action.agent} — check the EnGenAI panel for the response`
            );
          } catch (e: unknown) {
            const msg =
              e instanceof Error ? e.message : "Failed to send context";
            vscode.window.showErrorMessage(`EnGenAI: ${msg}`);
          }
        }
      );
    })
  );
}
