import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "https://localhost:5060",
        // target: "https://callsuite.cmxinnovations.com",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:5060",
        //target: "ws://callsuite.cmxinnovations.com",
        ws: true,
      },
    },
  },
});