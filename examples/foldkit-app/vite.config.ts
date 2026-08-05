import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [foldkit()],
  resolve: {
    dedupe: ["effect"],
  },
  server: {
    // The domain gateway (server.ts) owns /rpc; run it with `bun run server`.
    proxy: {
      "/rpc": "http://localhost:3001",
    },
    fs: {
      // The app imports the shared example domain and the library source
      // from outside its own directory.
      allow: ["../.."],
    },
  },
});
