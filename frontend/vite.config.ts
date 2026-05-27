import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Tauri: prevent Vite from obscuring rust errors
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // Tauri supports es2021
    target: ["es2021", "chrome105", "safari15"],
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          // React ecosystem
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          // State / data fetching
          "vendor-query": ["@tanstack/react-query", "axios"],
          // 3D rendering
          "vendor-three": ["three", "@react-three/fiber", "@react-three/drei"],
          // Map
          "vendor-leaflet": ["leaflet"],
          // Charts
          "vendor-recharts": ["recharts"],
        },
      },
    },
  },
}));
