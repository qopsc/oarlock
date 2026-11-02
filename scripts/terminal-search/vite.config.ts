import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  build: { outDir: process.env.OARLOCK_REGEX_PROBE_OUT ?? "/tmp/oarlock-regex-probe", emptyOutDir: true },
});
