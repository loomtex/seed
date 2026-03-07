import * as esbuild from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external: ["@kubernetes/client-node"],
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
};

await Promise.all([
  esbuild.build({
    ...shared,
    entryPoints: ["src/controller/index.ts"],
    outfile: "dist/controller.mjs",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["src/host-agent/index.ts"],
    outfile: "dist/host-agent.mjs",
  }),
]);

console.log("Build complete");
