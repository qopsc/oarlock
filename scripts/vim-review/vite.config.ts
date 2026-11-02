import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../../src", import.meta.url)),
      ...(process.env.VIM_BASELINE
        ? {
            "@replit/codemirror-vim": fileURLToPath(
              new URL(
                "../../packages/codemirror-vim/upstream/index.js",
                import.meta.url,
              ),
            ),
          }
        : {}),
    },
  },
  plugins: process.env.VIM_CORPUS
    ? [
        {
          name: "corpus",
          transformIndexHtml: {
            order: "pre",
            handler: (html: string) =>
              html.replace("/probe.ts", "/upstream-probe.js"),
          },
        },
      ]
    : [],
  build: {
    minify: !process.env.VIM_CORPUS,
    outDir: process.env.VIM_OUTPUT || "/tmp/oarlock-vim-probe",
    emptyOutDir: true,
  },
});
