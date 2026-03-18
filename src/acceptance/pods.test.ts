// Pod health invariant tests.

import type { AcceptanceTest, TestContext } from "./helpers.js";
import { LABELS, MANAGED_BY_VALUE } from "../shared/labels.js";

const category = "pods";

const noPodsInErrorState: AcceptanceTest = {
  name: "pods: no pods in error state",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.core.listPodForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    const badStates = ["ImagePullBackOff", "CrashLoopBackOff", "ErrImagePull", "Error"];
    const failing: string[] = [];

    for (const pod of items) {
      const statuses = [
        ...(pod.status?.containerStatuses ?? []),
        ...(pod.status?.initContainerStatuses ?? []),
      ];
      for (const cs of statuses) {
        const waiting = cs.state?.waiting?.reason;
        const terminated = cs.state?.terminated?.reason;
        const reason = waiting ?? terminated;
        if (reason && badStates.includes(reason)) {
          failing.push(`${pod.metadata?.namespace}/${pod.metadata?.name}: ${reason}`);
        }
      }
    }

    if (failing.length > 0) {
      return { pass: false, message: `${failing.length} pod(s) in error state:\n  ${failing.join("\n  ")}` };
    }
    return { pass: true, message: `${items.length} seed pods healthy` };
  },
};

const allDeploymentsAvailable: AcceptanceTest = {
  name: "pods: all deployments have available replicas",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.apps.listDeploymentForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    const unavailable: string[] = [];
    for (const dep of items) {
      const available = dep.status?.availableReplicas ?? 0;
      if (available < 1) {
        unavailable.push(`${dep.metadata?.namespace}/${dep.metadata?.name}: ${available} available`);
      }
    }

    if (unavailable.length > 0) {
      return { pass: false, message: `${unavailable.length} deployment(s) unavailable:\n  ${unavailable.join("\n  ")}` };
    }
    return { pass: true, message: `${items.length} deployments have available replicas` };
  },
};

const noRecentRestarts: AcceptanceTest = {
  name: "pods: no excessive container restarts",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.core.listPodForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    const threshold = 3;
    const restarting: string[] = [];

    for (const pod of items) {
      for (const cs of pod.status?.containerStatuses ?? []) {
        if (cs.restartCount > threshold) {
          restarting.push(
            `${pod.metadata?.namespace}/${pod.metadata?.name}/${cs.name}: ${cs.restartCount} restarts`,
          );
        }
      }
    }

    if (restarting.length > 0) {
      return {
        pass: false,
        message: `${restarting.length} container(s) with >${threshold} restarts:\n  ${restarting.join("\n  ")}`,
      };
    }
    return { pass: true, message: `no containers above ${threshold} restart threshold` };
  },
};

export const tests: AcceptanceTest[] = [
  noPodsInErrorState,
  allDeploymentsAvailable,
  noRecentRestarts,
];
