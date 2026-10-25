import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// The API has no CORS middleware, and it should not need one just for local
// development. Proxying keeps the browser on a single origin, so requests from
// the dashboard look exactly like requests from any other same host client.
//
// Prometheus gets the same treatment. Worker metrics are only ever summed
// there, since each worker serves its own counters on its own port, so the
// throughput figures on the overview have to come from its query API.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "VITE_");
  const apiTarget = env.VITE_API_TARGET || "http://localhost:8000";
  const prometheusTarget = env.VITE_PROMETHEUS_TARGET || "http://localhost:9090";

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
        "/prom": {
          target: prometheusTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/prom/, ""),
        },
      },
    },
  };
});
