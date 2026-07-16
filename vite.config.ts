import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

const yurucommuServerTarget =
  process.env.YURUME_DEV_PROXY_TARGET ?? "http://localhost:8787";

export default defineConfig({
  root: __dirname,
  plugins: [solid()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    port: 5174,
    allowedHosts: [".yurume.test", ".yurumeet.test", "localhost", "127.0.0.1"],
    proxy: {
      "/api": yurucommuServerTarget,
      "/healthz": yurucommuServerTarget,
      "/.well-known": yurucommuServerTarget,
    },
  },
});
