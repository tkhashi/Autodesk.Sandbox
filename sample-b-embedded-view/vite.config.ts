import { defineConfig } from "vite";

// Extensions are served over HTTPS and embedded as an iframe in Forma.
// For local development, run `npm run dev` and register the dev URL in the
// extension manifest (see README).
export default defineConfig({
  server: { port: 8081, host: true },
  build: { target: "es2022" },
});
