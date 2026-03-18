// Controller / reconciliation invariant tests.

import type { AcceptanceTest, TestContext } from "./helpers.js";
import { LABELS, MANAGED_BY_VALUE } from "../shared/labels.js";

const category = "controller";

const generationLabelsConsistent: AcceptanceTest = {
  name: "controller: generation labels are consistent within namespaces",
  category,
  async run(ctx: TestContext) {
    const [deployments, services] = await Promise.all([
      ctx.k8s.apps.listDeploymentForAllNamespaces({
        labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
      }),
      ctx.k8s.core.listServiceForAllNamespaces({
        labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
      }),
    ]);

    // Group generations by namespace
    const byNs = new Map<string, Set<string>>();
    const addGen = (ns: string | undefined, gen: string | undefined) => {
      if (!ns || !gen) return;
      if (!byNs.has(ns)) byNs.set(ns, new Set());
      byNs.get(ns)!.add(gen);
    };

    for (const dep of deployments.items) {
      addGen(dep.metadata?.namespace, dep.metadata?.labels?.[LABELS.GENERATION]);
    }
    // Only check ClusterIP services (ipv4/ipv6 LB services may lag)
    for (const svc of services.items) {
      if (svc.spec?.type === "ClusterIP") {
        addGen(svc.metadata?.namespace, svc.metadata?.labels?.[LABELS.GENERATION]);
      }
    }

    const inconsistent: string[] = [];
    for (const [ns, gens] of byNs) {
      if (gens.size > 1) {
        inconsistent.push(`${ns}: generations [${[...gens].join(", ")}]`);
      }
    }

    if (inconsistent.length > 0) {
      return {
        pass: false,
        message: `${inconsistent.length} namespace(s) with inconsistent generations:\n  ${inconsistent.join("\n  ")}`,
      };
    }
    return { pass: true, message: `${byNs.size} namespace(s) have consistent generation labels` };
  },
};

const controllerPodRunning: AcceptanceTest = {
  name: "controller: seed-controller is running",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.apps.listDeploymentForAllNamespaces({
      fieldSelector: "metadata.name=seed-controller",
    });

    if (items.length === 0) {
      return { pass: false, message: "seed-controller deployment not found" };
    }

    const dep = items[0];
    const available = dep.status?.availableReplicas ?? 0;
    if (available < 1) {
      return { pass: false, message: `seed-controller has ${available} available replicas` };
    }
    return { pass: true, message: "seed-controller running" };
  },
};

const hostAgentOnAllNodes: AcceptanceTest = {
  name: "controller: host-agent running on all nodes",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.apps.listDaemonSetForAllNamespaces({
      fieldSelector: "metadata.name=seed-host-agent",
    });

    if (items.length === 0) {
      return { pass: false, message: "seed-host-agent daemonset not found" };
    }

    const ds = items[0];
    const desired = ds.status?.desiredNumberScheduled ?? 0;
    const ready = ds.status?.numberReady ?? 0;

    if (ready < desired) {
      return { pass: false, message: `host-agent: ${ready}/${desired} ready` };
    }
    return { pass: true, message: `host-agent: ${ready}/${desired} ready on all nodes` };
  },
};

const seedNamespacesExist: AcceptanceTest = {
  name: "controller: seed namespaces exist",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.core.listNamespace();
    const seedNs = items
      .filter((ns) => ns.metadata?.name?.startsWith("s-"))
      .map((ns) => ns.metadata!.name!);

    if (seedNs.length === 0) {
      return { pass: false, message: "no seed namespaces (s-*) found" };
    }
    return { pass: true, message: `${seedNs.length} seed namespace(s): ${seedNs.join(", ")}` };
  },
};

export const tests: AcceptanceTest[] = [
  generationLabelsConsistent,
  controllerPodRunning,
  hostAgentOnAllNodes,
  seedNamespacesExist,
];
