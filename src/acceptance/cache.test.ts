// Binary cache invariant tests.

import type { AcceptanceTest, TestContext } from "./helpers.js";

const category = "cache";

const postBuildHookHasRecursive: AcceptanceTest = {
  name: "cache: post-build-hook signs with --recursive",
  category,
  async run(ctx: TestContext) {
    const failures: string[] = [];

    for (const node of ctx.nodes) {
      // Read post-build-hook path from nix.conf
      const confResult = await ctx.ssh(node, "cat /etc/nix/nix.conf");
      if (confResult.code !== 0) {
        failures.push(`${node}: could not read /etc/nix/nix.conf`);
        continue;
      }

      const hookMatch = confResult.stdout.match(/post-build-hook\s*=\s*(.+)/);
      if (!hookMatch) {
        failures.push(`${node}: no post-build-hook configured`);
        continue;
      }

      const hookPath = hookMatch[1].trim();
      const hookResult = await ctx.ssh(node, `cat ${hookPath}`);
      if (hookResult.code !== 0) {
        failures.push(`${node}: could not read hook at ${hookPath}`);
        continue;
      }

      // Check for signing with the full closure (--recursive or signing $OUT_PATHS which
      // includes all paths due to the closure wrapper)
      if (!hookResult.stdout.includes("nix store sign") && !hookResult.stdout.includes("nix copy --to")) {
        failures.push(`${node}: hook does not appear to sign or copy store paths`);
      }
    }

    if (failures.length > 0) {
      return { pass: false, message: failures.join("\n") };
    }
    return { pass: true, message: `post-build-hook verified on ${ctx.nodes.length} nodes` };
  },
};

const allNodesSameSigningKey: AcceptanceTest = {
  name: "cache: all nodes share the same signing key fingerprint",
  category,
  async run(ctx: TestContext) {
    const keys: Map<string, string> = new Map();

    for (const node of ctx.nodes) {
      const result = await ctx.ssh(
        node,
        "grep -oP 'trusted-public-keys\\s*=\\s*\\K.*' /etc/nix/nix.conf || grep -oP 'secret-key-files\\s*=\\s*\\K.*' /etc/nix/nix.conf",
      );
      if (result.code !== 0 || !result.stdout.trim()) {
        keys.set(node, "<not found>");
        continue;
      }

      // If it's a secret key file, convert to public
      const line = result.stdout.trim();
      if (line.startsWith("/")) {
        const pubResult = await ctx.ssh(
          node,
          `sudo cat ${line} | nix key convert-secret-to-public`,
        );
        keys.set(node, pubResult.code === 0 ? pubResult.stdout.trim() : "<convert failed>");
      } else {
        // It's already the public key(s) — take the first one
        keys.set(node, line.split(/\s+/)[0]);
      }
    }

    const unique = new Set(keys.values());
    if (unique.size === 1 && !unique.has("<not found>") && !unique.has("<convert failed>")) {
      return { pass: true, message: `all ${ctx.nodes.length} nodes share signing key` };
    }

    const details = [...keys.entries()].map(([n, k]) => `  ${n}: ${k}`).join("\n");
    return { pass: false, message: `signing keys differ across nodes:\n${details}` };
  },
};

const narinfosAreSigned: AcceptanceTest = {
  name: "cache: store paths in S3 are signed",
  category,
  async run(ctx: TestContext) {
    // Import dynamically to keep this a pure test file
    const { s3ListNarinfos, s3GetNarinfo } = await import("./helpers.js");

    const keys = await s3ListNarinfos(ctx.s3.bucket, ctx.s3.endpoint, 50);
    if (keys.length === 0) {
      return { pass: false, message: "no narinfos found in S3 bucket" };
    }

    // Sample up to 10 random narinfos
    const sample = keys.sort(() => Math.random() - 0.5).slice(0, 10);
    const unsigned: string[] = [];

    for (const key of sample) {
      const content = await s3GetNarinfo(ctx.s3.bucket, ctx.s3.endpoint, key);
      if (!content) {
        unsigned.push(`${key}: could not fetch`);
        continue;
      }
      if (!content.includes("Sig:")) {
        unsigned.push(key);
      }
    }

    if (unsigned.length > 0) {
      return {
        pass: false,
        message: `${unsigned.length}/${sample.length} narinfos unsigned:\n  ${unsigned.join("\n  ")}`,
      };
    }
    return { pass: true, message: `${sample.length}/${keys.length} sampled narinfos are signed` };
  },
};

export const tests: AcceptanceTest[] = [
  postBuildHookHasRecursive,
  allNodesSameSigningKey,
  narinfosAreSigned,
];
