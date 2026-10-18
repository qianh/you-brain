import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.VITE_DAEMON_URL || "http://127.0.0.1:3921";
  return {
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      proxy: {
        "/api": {
          target,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
