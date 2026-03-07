// Builder Job management — creates k8s Jobs for nix build + eval,
// reads results from ConfigMaps.

import type * as k8s from "@kubernetes/client-node";
import type { KubeClients } from "../shared/kube.js";
import { log, waitFor } from "../shared/kube.js";
import { seedLabels, LABELS, MANAGED_BY_VALUE } from "../shared/labels.js";
import type { BuildResult, SeedMeta } from "../shared/types.js";

const BUILDER_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Run builder Jobs for all instances and collect results.
 * Returns a Map of instance name → BuildResult, or throws on failure.
 */
export async function runBuilders(
  clients: KubeClients,
  flakePath: string,
  instanceNames: string[],
  namespace: string,
  builderImage: string,
  generation: string,
  useRefresh: boolean,
): Promise<Map<string, BuildResult>> {
  const results = new Map<string, BuildResult>();
  const jobs: { name: string; jobName: string }[] = [];

  // Clean up old builder resources
  await cleanupBuilderResources(clients, namespace);

  // Create Jobs for all instances
  for (const name of instanceNames) {
    const jobName = `seed-build-${name}-${generation.slice(0, 8)}`;
    const refreshFlag = useRefresh ? "--refresh" : "";

    const job = createBuilderJob(
      jobName,
      name,
      namespace,
      builderImage,
      flakePath,
      generation,
      refreshFlag,
    );

    try {
      await clients.batch.createNamespacedJob({ namespace, body: job });
      log("builder", `created Job ${jobName}`, name);
      jobs.push({ name, jobName });
    } catch (err) {
      throw new Error(`Failed to create builder Job for ${name}: ${err}`);
    }
  }

  // Wait for all Jobs to complete
  for (const { name, jobName } of jobs) {
    const success = await waitFor(
      async () => {
        try {
          const job = await clients.batch.readNamespacedJob({
            name: jobName,
            namespace,
          });
          const conditions = job.status?.conditions || [];
          const complete = conditions.find((c) => c.type === "Complete" && c.status === "True");
          const failed = conditions.find((c) => c.type === "Failed" && c.status === "True");

          if (failed) {
            throw new Error(`Builder Job ${jobName} failed: ${failed.message}`);
          }
          return !!complete;
        } catch (err) {
          if (err instanceof Error && err.message.includes("failed")) throw err;
          return false;
        }
      },
      3000, // 3s poll interval
      BUILDER_TIMEOUT_MS,
    );

    if (!success) {
      throw new Error(`Builder Job ${jobName} timed out after ${BUILDER_TIMEOUT_MS / 1000}s`);
    }

    // Read result from ConfigMap
    try {
      const cm = await clients.core.readNamespacedConfigMap({
        name: `seed-build-${name}`,
        namespace,
      });
      const imagePath = cm.data?.["imagePath"];
      const metaJson = cm.data?.["meta"];
      if (!imagePath || !metaJson) {
        throw new Error(`ConfigMap seed-build-${name} missing imagePath or meta`);
      }
      results.set(name, {
        imagePath,
        meta: JSON.parse(metaJson) as SeedMeta,
      });
      log("builder", `build complete: ${imagePath}`, name);
    } catch (err) {
      throw new Error(`Failed to read build result for ${name}: ${err}`);
    }
  }

  return results;
}

/** Create a builder Job manifest. */
function createBuilderJob(
  jobName: string,
  instanceName: string,
  namespace: string,
  builderImage: string,
  flakePath: string,
  generation: string,
  refreshFlag: string,
): k8s.V1Job {
  // Builder script: runs nix build + eval, writes results to ConfigMap via kubectl
  const script = `
set -euo pipefail

echo "[builder] building ${instanceName}..."
image_path=$(nix build "${flakePath}#seeds.${instanceName}.image" --no-link --print-out-paths ${refreshFlag} 2>&1 | tail -1)
echo "[builder] image: $image_path"

echo "[builder] evaluating metadata..."
meta=$(nix eval "${flakePath}#seeds.${instanceName}.meta" --json ${refreshFlag})
echo "[builder] meta: $meta"

# Write results to ConfigMap
cat <<CMEOF | kubectl apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: seed-build-${instanceName}
  namespace: ${namespace}
  labels:
    seed.loom.farm/managed-by: seed
    seed.loom.farm/instance: ${instanceName}
    seed.loom.farm/builder: "true"
data:
  imagePath: "$image_path"
  meta: |
    $meta
CMEOF

echo "[builder] done"
`;

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: jobName,
      namespace,
      labels: {
        ...seedLabels(instanceName, generation),
        [`${LABELS.MANAGED_BY}`]: MANAGED_BY_VALUE,
        "seed.loom.farm/builder": "true",
      },
    },
    spec: {
      backoffLimit: 1,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: {
          labels: {
            "seed.loom.farm/builder": "true",
            [LABELS.INSTANCE]: instanceName,
          },
        },
        spec: {
          // Default runtime — NOT Kata. Unix sockets don't traverse virtiofs.
          restartPolicy: "Never",
          serviceAccountName: "seed-builder",
          containers: [
            {
              name: "builder",
              image: builderImage,
              command: ["/bin/sh", "-c", script],
              volumeMounts: [
                {
                  name: "nix-daemon",
                  mountPath: "/nix/var/nix/daemon-socket",
                },
                {
                  name: "nix-store",
                  mountPath: "/nix/store",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "nix-daemon",
              hostPath: { path: "/nix/var/nix/daemon-socket" },
            },
            {
              name: "nix-store",
              hostPath: { path: "/nix/store" },
            },
          ],
        },
      },
    },
  };
}

/** Clean up old builder Jobs and ConfigMaps. */
async function cleanupBuilderResources(
  clients: KubeClients,
  namespace: string,
): Promise<void> {
  try {
    // Delete old builder Jobs
    const jobs = await clients.batch.listNamespacedJob({ namespace });
    for (const job of jobs.items) {
      if (job.metadata?.labels?.["seed.loom.farm/builder"] === "true") {
        const conditions = job.status?.conditions || [];
        const isDone = conditions.some(
          (c) => (c.type === "Complete" || c.type === "Failed") && c.status === "True",
        );
        if (isDone && job.metadata.name) {
          await clients.batch.deleteNamespacedJob({
            name: job.metadata.name,
            namespace,
            body: { propagationPolicy: "Background" },
          });
        }
      }
    }

    // Delete old builder ConfigMaps
    const cms = await clients.core.listNamespacedConfigMap({ namespace });
    for (const cm of cms.items) {
      if (cm.metadata?.labels?.["seed.loom.farm/builder"] === "true" && cm.metadata.name) {
        await clients.core.deleteNamespacedConfigMap({
          name: cm.metadata.name,
          namespace,
        });
      }
    }
  } catch {
    // Cleanup is best-effort
  }
}
