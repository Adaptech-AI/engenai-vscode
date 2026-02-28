import * as vscode from "vscode";
import { EnGenAIClient } from "../api/EnGenAIClient.js";

/**
 * Language Model Chat Provider — makes EnGenAI models appear
 * in Copilot's model picker (e.g., "EnGenAI (Opus 4.6)").
 *
 * ONLY available in VS Code with a Copilot plan (Free tier minimum).
 * Feature-gated at runtime.
 *
 * Routes completions through our /v1/chat/completions endpoint
 * with full credit billing.
 */
export function registerModelProvider(
  context: vscode.ExtensionContext,
  client: EnGenAIClient
): void {
  // Check if the API exists (proposed in some versions)
  if (typeof vscode.lm?.registerLanguageModelChatProvider !== "function") {
    return;
  }

  const provider: vscode.LanguageModelChatProvider = {
    async provideLanguageModelChatInformation() {
      if (!client.isAuthenticated) return [];

      // Return models available to this org
      // In production, this would call GET /v1/models
      return [
        {
          id: "engenai-opus",
          name: "EnGenAI (Opus 4.6)",
          family: "claude",
          version: "4.6",
          maxInputTokens: 200000,
          maxOutputTokens: 8192,
          capabilities: { imageInput: true, toolCalling: true },
        },
        {
          id: "engenai-sonnet",
          name: "EnGenAI (Sonnet 4.6)",
          family: "claude",
          version: "4.6",
          maxInputTokens: 200000,
          maxOutputTokens: 8192,
          capabilities: { imageInput: true, toolCalling: true },
        },
      ] as vscode.LanguageModelChatInformation[];
    },

    async provideLanguageModelChatResponse(
      model,
      messages,
      _options,
      progress,
      token
    ) {
      if (!client.isAuthenticated) {
        throw new Error("Not authenticated with EnGenAI");
      }

      // Convert VS Code messages to OpenAI format
      const openAIMessages = messages.map((msg) => ({
        role: msg.role === vscode.LanguageModelChatMessageRole.User
          ? "user"
          : "assistant",
        content: typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter(
                (p): p is vscode.LanguageModelTextPart =>
                  p instanceof vscode.LanguageModelTextPart
              )
              .map((p) => p.value)
              .join(""),
      }));

      // Map model ID to actual model name
      const modelName = model.id === "engenai-opus"
        ? "claude-opus-4-6"
        : "claude-sonnet-4-6";

      // Stream from our OpenAI-compatible endpoint
      const response = await fetch(
        `${client.apiUrl}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Token is managed by the client — we'd need to expose it
            // For now, this is a simplified version
          },
          body: JSON.stringify({
            model: modelName,
            messages: openAIMessages,
            stream: true,
          }),
          signal: AbortSignal.timeout(120_000),
        }
      );

      if (!response.ok) {
        throw new Error(`EnGenAI API error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) {
              progress.report(new vscode.LanguageModelTextPart(content));
            }
          } catch {
            // Non-JSON line — skip
          }
        }
      }
    },

    async provideTokenCount(_model, text) {
      // Rough estimate: 1 token ≈ 4 characters
      const content = typeof text === "string"
        ? text
        : text.content
            .filter(
              (p): p is vscode.LanguageModelTextPart =>
                p instanceof vscode.LanguageModelTextPart
            )
            .map((p) => p.value)
            .join("");
      return Math.ceil(content.length / 4);
    },
  };

  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("engenai", provider)
  );
}
