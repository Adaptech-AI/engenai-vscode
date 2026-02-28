/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Map VS Code theme colors to Tailwind
        foreground: "var(--vscode-foreground)",
        background: "var(--vscode-sideBar-background)",
        "input-bg": "var(--vscode-input-background)",
        "input-fg": "var(--vscode-input-foreground)",
        "input-border": "var(--vscode-input-border)",
        "btn-bg": "var(--vscode-button-background)",
        "btn-fg": "var(--vscode-button-foreground)",
        "btn-hover": "var(--vscode-button-hoverBackground)",
        "focus-border": "var(--vscode-focusBorder)",
        "badge-bg": "var(--vscode-badge-background)",
        "badge-fg": "var(--vscode-badge-foreground)",
        // Agent colors
        "agent-keith": "#22C55E",
        "agent-sophi": "#A855F7",
        "agent-marv": "#3B82F6",
        "agent-promi": "#F97316",
        "agent-sage": "#EAB308",
      },
      fontFamily: {
        vscode: "var(--vscode-font-family)",
      },
      fontSize: {
        vscode: "var(--vscode-font-size)",
      },
    },
  },
  plugins: [],
};
