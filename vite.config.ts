import { defineConfig } from "vite";
import { resolve } from "node:path";

// The add-in is pure static output. `base: "./"` keeps every asset path relative,
// so /dist can be hosted at a domain root or under any sub-path.
export default defineConfig({
  root: "addin",
  base: "./",
  publicDir: "public",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2019",
    rollupOptions: {
      input: {
        index: resolve(__dirname, "addin/index.html"),
        redirect: resolve(__dirname, "addin/redirect.html"),
      },
    },
  },
  server: { port: 3000 },
});
