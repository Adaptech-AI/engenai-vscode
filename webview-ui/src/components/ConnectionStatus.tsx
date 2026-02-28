import { useAppStore } from "../store";

export function ConnectionStatus() {
  const { connectionState, user, signIn, signInWithBrowser } = useAppStore();

  if (connectionState === "connected") {
    return (
      <div className="px-3 py-2 text-xs opacity-70 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
        Connected as {user?.email}
      </div>
    );
  }

  if (connectionState === "connecting") {
    return (
      <div className="px-3 py-2 text-xs opacity-70 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse inline-block" />
        Connecting...
      </div>
    );
  }

  if (connectionState === "offline") {
    return (
      <div className="px-3 py-2 text-xs text-yellow-400 flex items-center gap-1.5">
        <span className="w-2 h-2 rounded-full bg-yellow-500 inline-block" />
        Offline — retrying...
      </div>
    );
  }

  if (connectionState === "invalid_key") {
    return (
      <div className="p-3">
        <p className="text-xs text-red-400 mb-2">API key is invalid or revoked.</p>
        <button onClick={signIn} className="w-full py-1.5 px-3 text-xs rounded bg-btn-bg text-btn-fg hover:bg-btn-hover">
          Sign In Again
        </button>
      </div>
    );
  }

  // disconnected
  return (
    <div className="p-4 flex flex-col items-center gap-3">
      <div className="text-center">
        <h3 className="text-sm font-semibold mb-1">Welcome to EnGenAI</h3>
        <p className="text-xs opacity-70">Sign in to connect to your agents</p>
      </div>
      <button onClick={signIn} className="w-full py-2 px-3 text-sm rounded bg-btn-bg text-btn-fg hover:bg-btn-hover">
        Sign In with API Key
      </button>
      <button onClick={signInWithBrowser} className="w-full py-1.5 px-3 text-xs rounded border border-input-border text-foreground opacity-80 hover:opacity-100">
        Sign In with Browser
      </button>
    </div>
  );
}
