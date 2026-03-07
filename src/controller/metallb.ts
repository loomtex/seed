// MetalLB IPAddressPool + L2Advertisement configuration.

import type { KubeClients } from "../shared/kube.js";
import { log, waitFor } from "../shared/kube.js";

const CRD_GROUP = "metallb.io";
const CRD_VERSION = "v1beta1";
const METALLB_NAMESPACE = "metallb-system";

/** Configure MetalLB address pools from IPv4/IPv6 addresses. */
export async function configureMetalLB(
  clients: KubeClients,
  ipv4Address: string,
  ipv6Block: string,
): Promise<void> {
  if (!ipv4Address && !ipv6Block) return;

  log("metallb", "waiting for CRDs and webhook...");

  const ready = await waitFor(
    async () => {
      try {
        // Check CRD exists
        const api = clients.custom;
        await api.listNamespacedCustomObject({
          group: CRD_GROUP,
          version: CRD_VERSION,
          namespace: METALLB_NAMESPACE,
          plural: "ipaddresspools",
        });

        // Check webhook endpoint has addresses
        const ep = await clients.core.readNamespacedEndpoints({
          name: "metallb-webhook-service",
          namespace: METALLB_NAMESPACE,
        });
        const addresses = ep.subsets?.[0]?.addresses;
        return !!addresses && addresses.length > 0;
      } catch {
        return false;
      }
    },
    5000, // 5s poll interval
    300_000, // 5 minute timeout
  );

  if (!ready) {
    log("metallb", "not ready after 5 minutes, skipping pool config");
    return;
  }

  // Build address list
  const addresses: string[] = [];
  if (ipv4Address) addresses.push(`${ipv4Address}/32`);
  if (ipv6Block) addresses.push(ipv6Block);

  log("metallb", `configuring address pool: ${JSON.stringify(addresses)}`);

  // Apply IPAddressPool
  const pool = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: "IPAddressPool",
    metadata: {
      name: "seed-pool",
      namespace: METALLB_NAMESPACE,
    },
    spec: {
      addresses,
      autoAssign: false,
    },
  };

  await applyCustomResource(
    clients.custom,
    CRD_GROUP,
    CRD_VERSION,
    METALLB_NAMESPACE,
    "ipaddresspools",
    "seed-pool",
    pool,
  );

  // Apply L2Advertisement
  const l2 = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: "L2Advertisement",
    metadata: {
      name: "seed-l2",
      namespace: METALLB_NAMESPACE,
    },
    spec: {
      ipAddressPools: ["seed-pool"],
    },
  };

  await applyCustomResource(
    clients.custom,
    CRD_GROUP,
    CRD_VERSION,
    METALLB_NAMESPACE,
    "l2advertisements",
    "seed-l2",
    l2,
  );

  log("metallb", "pool configuration complete");
}

/** Create-or-update a custom resource. */
async function applyCustomResource(
  api: import("@kubernetes/client-node").CustomObjectsApi,
  group: string,
  version: string,
  namespace: string,
  plural: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await api.getNamespacedCustomObject({ group, version, namespace, plural, name });
    // Exists — update it
    try {
      await api.replaceNamespacedCustomObject({ group, version, namespace, plural, name, body });
      log("metallb", `updated ${plural}/${name}`);
    } catch (replaceErr) {
      log("metallb", `failed to update ${plural}/${name}: ${replaceErr}`);
    }
  } catch {
    // Doesn't exist (or get failed) — try create
    try {
      await api.createNamespacedCustomObject({ group, version, namespace, plural, body });
      log("metallb", `created ${plural}/${name}`);
    } catch (createErr) {
      // 409 = already exists, which is fine
      const code = (createErr as { code?: number }).code;
      if (code === 409) {
        log("metallb", `${plural}/${name} already exists, skipping`);
      } else {
        throw createErr;
      }
    }
  }
}
