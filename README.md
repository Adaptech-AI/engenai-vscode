# EnGenAI — AI Development Platform in Your IDE

> **The Machine That Builds Machines — now in your editor.**

EnGenAI brings your multi-agent AI development team directly into VS Code, Cursor, Windsurf, and other VS Code-compatible editors. Talk to Keith (your AI CPO), watch Sophi build your backend, see Marv craft your frontend — all without leaving your IDE.

## Features

### Multi-Agent Chat Sidebar

Chat with your entire AI development team from the sidebar:

- **Keith** (CPO) — Plan features, define requirements, coordinate agents
- **Sophi** (Backend) — Write APIs, fix bugs, generate tests
- **Marv** (Frontend) — Build UI components, style pages
- **PROMI** (Orchestrator) — Route tasks, manage workflows

Use `@Keith plan a REST API for user auth` or `@Sophi /fix` with selected code.

### Dev-Vault Explorer

Your project's Dev-Vault appears as a virtual folder in VS Code Explorer. Browse files created by agents, see real-time updates as agents work, and diff agent-created files against your local workspace.

- Files appear within seconds of agent creation
- Right-click to diff with local files
- Read-only (agents create, you review)

### Smart Context Pipeline

Right-click any code and select **"Ask EnGenAI"** to send it to your agents with intelligent context:

- Selected code + surrounding context (free)
- Related functions and types from your project (indexed)
- Full file on demand when needed

### EnGen-Copilot (VS Code only)

In VS Code, EnGenAI integrates with Copilot Chat:

- Type `@engenai /plan` to plan features with Keith
- Type `@engenai /fix` with code selected to fix bugs with Sophi
- EnGenAI models appear in Copilot's model picker

## Getting Started

### 1. Install

- **VS Code**: Search "EnGenAI" in Extensions
- **Cursor / Windsurf**: Available via OpenVSX
- **Manual**: Download `.vsix` from [Releases](https://github.com/Adaptech-AI/engenai-vscode/releases)

### 2. Sign In

Click the EnGenAI icon in the Activity Bar:

- **API Key**: Paste your PAT (`eng_live_...`) from [Settings](https://dev.engenai.app/settings/developer)
- **Browser**: Use Device Flow — enter a code in your browser

### 3. Select Project and Chat

Choose your project, then type `@Keith plan a user authentication system`.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `engenai.serverUrl` | `https://dev.engenai.app` | Platform URL |
| `engenai.autoConnect` | `true` | Auto-connect on startup |

## Multi-IDE Support

| IDE | Sidebar | Dev-Vault | @engenai Copilot | Model Picker |
|-----|---------|-----------|-----------------|--------------|
| VS Code | Yes | Yes | Yes | Yes |
| Cursor | Yes | Yes | — | — |
| Windsurf | Yes | Yes | — | — |
| VSCodium | Yes | Yes | — | — |

## Privacy

- API keys stored in OS keychain (never plaintext)
- No telemetry collected
- Extension only communicates with your configured server

## License

Apache 2.0 — [Adaptech AI Ltd](https://engenai.app)
