import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

// Builds the client bundle only (`vite build --outDir dist/client`). Serving —
// SSR HTML, /rpc, static assets — is server/main.ts; there is no vite dev
// host here because the repo state must live in exactly one process.
export default defineConfig({
  plugins: [foldkit()],
  resolve: {
    dedupe: ["effect"],
  },
  server: {
    fs: {
      // The app imports the shared example domain and the library source
      // from outside its own directory.
      allow: ["../.."],
    },
  },
});
