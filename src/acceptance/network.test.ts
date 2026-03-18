// Network / service / DNS invariant tests.

import type { AcceptanceTest, TestContext, ExecResult } from "./helpers.js";
import { LABELS, MANAGED_BY_VALUE } from "../shared/labels.js";

const category = "network";

const loadBalancersHaveIPs: AcceptanceTest = {
  name: "network: all LoadBalancer services have external IPs",
  category,
  async run(ctx: TestContext) {
    const { items } = await ctx.k8s.core.listServiceForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    const lbs = items.filter((s) => s.spec?.type === "LoadBalancer");
    const missing: string[] = [];

    for (const svc of lbs) {
      const ingress = svc.status?.loadBalancer?.ingress;
      if (!ingress || ingress.length === 0) {
        missing.push(`${svc.metadata?.namespace}/${svc.metadata?.name}`);
      }
    }

    if (missing.length > 0) {
      return {
        pass: false,
        message: `${missing.length} LoadBalancer(s) missing external IP:\n  ${missing.join("\n  ")}`,
      };
    }
    return { pass: true, message: `${lbs.length} LoadBalancer services have external IPs` };
  },
};

const noServiceThrashing: AcceptanceTest = {
  name: "network: no service generation thrashing",
  category,
  async run(ctx: TestContext) {
    const list1 = await ctx.k8s.core.listServiceForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    // Wait 10s and check again
    await new Promise((r) => setTimeout(r, 10_000));

    const list2 = await ctx.k8s.core.listServiceForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE}`,
    });

    const gen1 = new Map(
      list1.items.map((s) => [
        `${s.metadata?.namespace}/${s.metadata?.name}`,
        s.metadata?.generation ?? 0,
      ]),
    );

    const thrashing: string[] = [];
    for (const svc of list2.items) {
      const key = `${svc.metadata?.namespace}/${svc.metadata?.name}`;
      const prev = gen1.get(key);
      const curr = svc.metadata?.generation ?? 0;
      if (prev !== undefined && curr > prev) {
        thrashing.push(`${key}: generation ${prev} -> ${curr}`);
      }
    }

    if (thrashing.length > 0) {
      return {
        pass: false,
        message: `${thrashing.length} service(s) thrashing:\n  ${thrashing.join("\n  ")}`,
      };
    }
    return { pass: true, message: `${list2.items.length} services stable over 10s window` };
  },
};

const acmeCertsValid: AcceptanceTest = {
  name: "network: ACME certs are valid with >7d expiry",
  category,
  async run(ctx: TestContext) {
    // Find services with HTTP expose (likely HTTPS endpoints)
    const { items } = await ctx.k8s.core.listServiceForAllNamespaces({
      labelSelector: `${LABELS.MANAGED_BY}=${MANAGED_BY_VALUE},${LABELS.SERVICE_TYPE}=ipv4`,
    });

    if (items.length === 0) {
      return { pass: true, message: "no IPv4 ingress services to check" };
    }

    const failures: string[] = [];
    for (const svc of items) {
      const ingress = svc.status?.loadBalancer?.ingress;
      if (!ingress?.[0]) continue;

      const ip = ingress[0].ip;
      const instance = svc.metadata?.labels?.[LABELS.INSTANCE];
      if (!ip || !instance) continue;

      // Check if port 443 is in the service
      const has443 = svc.spec?.ports?.some((p) => p.port === 443);
      if (!has443) continue;

      const fqdn = `${instance}.loom.farm`;
      const result = await ctx.ssh(
        ctx.nodes[0],
        `echo | openssl s_client -connect ${ip}:443 -servername ${fqdn} 2>/dev/null | openssl x509 -noout -checkend 604800 2>/dev/null; echo $?`,
      );

      // openssl x509 -checkend returns 0 if cert is valid for N more seconds, 1 if not
      const exitLine = result.stdout.trim().split("\n").pop();
      if (exitLine !== "0") {
        failures.push(`${fqdn} (${ip}): cert expires within 7 days or is invalid`);
      }
    }

    if (failures.length > 0) {
      return { pass: false, message: `${failures.length} cert issue(s):\n  ${failures.join("\n  ")}` };
    }
    return { pass: true, message: "all HTTPS certs valid with >7d expiry" };
  },
};

export const tests: AcceptanceTest[] = [
  loadBalancersHaveIPs,
  noServiceThrashing,
  acmeCertsValid,
];
