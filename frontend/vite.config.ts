import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { strokeDataPlugin } from "./scripts/stroke-data-plugin.mjs";

const localApiProxyPath = "/__meoing_api";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const apiProxyTarget = env.MEOI_DEV_API_PROXY_TARGET?.trim();

  return {
    plugins: [react(), strokeDataPlugin()],
    build: { outDir: "dist-pages" },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      ...(apiProxyTarget
        ? {
          proxy: {
            [localApiProxyPath]: {
              target: apiProxyTarget,
              changeOrigin: true,
              rewrite: (path) => path.replace(localApiProxyPath, ""),
            },
          },
        }
        : {}),
    },
  };
});
