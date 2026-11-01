import { defineConfig, type Plugin } from 'vite';

// Strict content policy for the built site: own files only, no third-party scripts or
// network calls. 'wasm-unsafe-eval' lets the Argon2 WebAssembly run. Dev server is left alone.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const csp = (): Plugin => ({
  name: 'csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  base: './',
  plugins: [csp()],
  test: { include: ['tests/**/*.test.ts'] },
} as any);
