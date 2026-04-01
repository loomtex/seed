// Pool manager HTTP client — dispatches nix eval to sandboxed VM pool.
// The pool manager runs as a DaemonSet, accessed via k8s Service.
//
// Architecture: eval runs in the pool VM (untrusted flake code), build
// uses the controller's direct nix-daemon connection (daemon handles
// its own sandboxing).
//
// The pool VM has:
// - /nix/store via overlayfs (virtiofs lower, tmpfs upper for lock files)
// - nix store DB copied from host (path validation)
// - nix fetcher cache from host (flake input resolution)
// - NIX_REMOTE="" (no daemon — eval only)

import { log } from "../shared/kube.js";
import type { BuildResult, SeedMeta } from "../shared/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Request to the pool manager /exec endpoint. */
interface ExecRequest {
  command: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/** Response from the pool manager /exec endpoint. */
interface ExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Execute a command in a pool VM. */
async function poolExec(
  poolUrl: string,
  request: ExecRequest,
): Promise<ExecResponse> {
  const resp = await fetch(`${poolUrl}/exec`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (!resp.ok) {
    throw new Error(`pool manager returned ${resp.status}: ${await resp.text()}`);
  }

  return (await resp.json()) as ExecResponse;
}

/**
 * Pre-fetch a flake and get its resolved source store path + input store paths.
 * Runs on the controller (trusted context, has network + nix-daemon).
 */
async function prefetchFlake(
  flakePath: string,
  useRefresh: boolean,
): Promise<{ sourcePath: string; inputs: Map<string, string> }> {
  // Get the flake archive (ensures all inputs are in the store)
  const archiveArgs = ["flake", "archive", flakePath, "--json"];
  if (useRefresh) archiveArgs.push("--refresh");
  const { stdout: archiveJson } = await execFileAsync("nix", archiveArgs, { timeout: 120_000 });
  const archive = JSON.parse(archiveJson);

  const sourcePath = archive.path as string;
  const inputs = new Map<string, string>();
  if (archive.inputs) {
    for (const [name, info] of Object.entries(archive.inputs as Record<string, { path: string }>)) {
      inputs.set(name, info.path);
    }
  }

  log("pool-client", `prefetched ${flakePath} → ${sourcePath} (${inputs.size} inputs)`);
  return { sourcePath, inputs };
}

/**
 * Evaluate a nix expression via the pool manager VM.
 * The flake source must be pre-fetched and available in /nix/store.
 *
 * Uses --override-input to point inputs at pre-fetched store paths,
 * avoiding network access in the pool VM.
 */
async function poolFlakeEval(
  poolUrl: string,
  sourcePath: string,
  inputs: Map<string, string>,
  attr: string,
  extraArgs: string[],
): Promise<string> {
  // Build nix eval command with input overrides.
  // Copy source to tmpfs + add marker so nix doesn't try to lock the
  // original store path (nix content-addresses the source and would
  // try to lock the matching store path on read-only virtiofs).
  const overrides: string[] = [];
  for (const [name, path] of inputs) {
    overrides.push("--override-input", name, `path:${path}`);
  }

  const shellCmd = [
    `cp -r ${sourcePath} /tmp/flake`,
    `echo pool > /tmp/flake/.pool-marker`,
    `nix eval path:/tmp/flake#${attr} --json --no-update-lock-file ${overrides.join(" ")} ${extraArgs.join(" ")}`,
  ].join(" && ");

  const resp = await poolExec(poolUrl, {
    command: ["sh", "-c", shellCmd],
    timeout: 120_000,
  });

  if (resp.exitCode !== 0) {
    throw new Error(`nix eval failed in pool VM (exit ${resp.exitCode}): ${resp.stderr}`);
  }

  return resp.stdout;
}

/**
 * Build all instances via pool manager (eval) + direct nix (build).
 *
 * 1. Pre-fetches the flake and resolves input store paths (controller, trusted)
 * 2. Evaluates instance list + metadata in pool VMs (sandboxed)
 * 3. Builds images directly via controller's nix-daemon (daemon handles isolation)
 */
export async function runViaPoolManager(
  poolUrl: string,
  flakePath: string,
  instanceNames: string[],
  useRefresh: boolean,
): Promise<Map<string, BuildResult>> {
  // Pre-fetch flake and resolve all inputs to store paths
  const { sourcePath, inputs } = await prefetchFlake(flakePath, useRefresh);

  // Eval + build all instances in parallel. The pool manager's slot
  // acquisition blocks when all slots are busy, so pool size is the
  // natural concurrency limit for eval. Builds go to nix-daemon which
  // handles its own scheduling.
  const entries = await Promise.all(
    instanceNames.map(async (name): Promise<[string, BuildResult]> => {
      // Eval metadata in pool VM (sandboxed)
      log("pool-client", `evaluating metadata...`, name);
      const metaJson = await poolFlakeEval(
        poolUrl,
        sourcePath,
        inputs,
        `seeds.${name}.meta`,
        [],
      );
      const meta = JSON.parse(metaJson) as SeedMeta;

      // Build image directly via controller's nix-daemon (not sandboxed — daemon handles it)
      log("pool-client", `building image...`, name);
      const buildArgs = [
        "build",
        `${flakePath}#seeds.${name}.image`,
        "--no-link",
        "--print-out-paths",
      ];
      if (useRefresh) buildArgs.push("--refresh");
      const { stdout: buildOut } = await execFileAsync("nix", buildArgs, { timeout: 600_000 });
      const imagePath = buildOut.trim();

      log("pool-client", `image: ${imagePath}`, name);
      return [name, { imagePath, meta }];
    }),
  );

  return new Map(entries);
}

