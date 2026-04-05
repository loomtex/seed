import { defineConfig } from "vite";

export default defineConfig({
  base: "/ui/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
