import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://callsuite.cmxinnovations.com",
        changeOrigin: true,
      },
      "/ws": {
        target: "wss://callsuite.cmxinnovations.com",
        ws: true,
      },
    },
  },
});