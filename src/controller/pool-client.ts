// Pool manager HTTP client — dispatches nix eval/build to VM pool.
// The pool manager runs as a DaemonSet, accessed via k8s Service.

import { log } from "../shared/kube.js";
import type { BuildResult, SeedMeta } from "../shared/types.js";

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
 * Build all instances via the pool manager.
 * Dispatches nix build + eval for each instance in a separate VM.
 */
export async function runViaPoolManager(
  poolUrl: string,
  flakePath: string,
  instanceNames: string[],
  useRefresh: boolean,
): Promise<Map<string, BuildResult>> {
  const results = new Map<string, BuildResult>();

  // Build each instance sequentially (each gets its own VM)
  for (const name of instanceNames) {
    log("pool-client", `building image...`, name);

    // nix build — returns store path
    const buildResp = await poolExec(poolUrl, {
      command: [
        "nix", "build",
        `${flakePath}#seeds.${name}.image`,
        "--no-link", "--print-out-paths",
        ...(useRefresh ? ["--refresh"] : []),
      ],
      timeout: 600_000,
    });

    if (buildResp.exitCode !== 0) {
      throw new Error(
        `nix build failed for ${name} (exit ${buildResp.exitCode}): ${buildResp.stderr}`,
      );
    }

    const imagePath = buildResp.stdout.trim();
    log("pool-client", `image: ${imagePath}`, name);

    // nix eval — returns metadata JSON
    log("pool-client", `evaluating metadata...`, name);
    const evalResp = await poolExec(poolUrl, {
      command: [
        "nix", "eval",
        `${flakePath}#seeds.${name}.meta`,
        "--json",
        ...(useRefresh ? ["--refresh"] : []),
      ],
      timeout: 120_000,
    });

    if (evalResp.exitCode !== 0) {
      throw new Error(
        `nix eval failed for ${name} (exit ${evalResp.exitCode}): ${evalResp.stderr}`,
      );
    }

    const meta = JSON.parse(evalResp.stdout) as SeedMeta;
    results.set(name, { imagePath, meta });
  }

  return results;
}
