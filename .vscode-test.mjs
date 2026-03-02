import { defineConfig } from '@vscode/test-cli';

export default defineConfig([
  {
    // Unit tests run in Node.js directly — no VS Code or display required.
    // Integration tests (src/test/integration/) are excluded from CI and
    // run locally with `npx vscode-test` (requires VS Code installed).
    unitTests: {
      glob: 'out/test/unit/**/*.test.js',
    },
  },
]);
