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

// CLI tools don't need k8s client
const cli = {
  ...shared,
  external: [],
  banner: {},
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
  esbuild.build({
    ...shared,
    entryPoints: ["src/pool-manager/index.ts"],
    outfile: "dist/pool-manager.mjs",
  }),
  esbuild.build({
    ...shared,
    entryPoints: ["src/acceptance/index.ts"],
    outfile: "dist/acceptance.mjs",
  }),
  esbuild.build({
    ...cli,
    entryPoints: ["src/cli/identity.ts"],
    outfile: "dist/seed-identity.mjs",
  }),
  esbuild.build({
    ...cli,
    entryPoints: ["src/cli/sign.ts"],
    outfile: "dist/seed-sign.mjs",
  }),
]);

console.log("Build complete");
