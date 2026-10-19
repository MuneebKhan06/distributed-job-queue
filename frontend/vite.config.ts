import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The API has no CORS middleware, and it should not need one just for local
// development. Proxying keeps the browser on a single origin, so requests from
// the dashboard look exactly like requests from any other same host client.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const apiTarget = env.VITE_API_TARGET || "http://localhost:8000";

  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
