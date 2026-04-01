// MetalLB IPAddressPool + BGP/L2 advertisement configuration.

import type { KubeClients } from "../shared/kube.js";
import { log, waitFor } from "../shared/kube.js";

const CRD_GROUP = "metallb.io";
const CRD_VERSION = "v1beta1";
const CRD_VERSION_V2 = "v1beta2";
const METALLB_NAMESPACE = "metallb-system";

interface BGPConfig {
  myASN: number;
  peerASN: number;
  peerAddress: string;
  peerAddressIPv6: string;
  password: string;
}

/** Read BGP config from env vars. Returns null if BGP is not configured. */
export function readBGPConfig(): BGPConfig | null {
  const myASN = process.env["SEED_BGP_MY_ASN"];
  const peerASN = process.env["SEED_BGP_PEER_ASN"];
  if (!myASN || !peerASN) return null;

  return {
    myASN: parseInt(myASN, 10),
    peerASN: parseInt(peerASN, 10),
    peerAddress: process.env["SEED_BGP_PEER_ADDRESS"] || "169.254.1.1",
    peerAddressIPv6: process.env["SEED_BGP_PEER_ADDRESS_IPV6"] || "2001:19f0:ffff::1",
    password: process.env["SEED_BGP_PASSWORD"] || "",
  };
}

/** Configure MetalLB address pools and advertisements. */
export async function configureMetalLB(
  clients: KubeClients,
  ipv4Address: string,
  ipv6Block: string,
  bgp: BGPConfig | null,
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

  if (bgp) {
    await configureBGP(clients, bgp, ipv4Address, ipv6Block);
  } else {
    await configureL2(clients);
  }

  log("metallb", "pool configuration complete");
}

/** Get each node's public IPv6 address from the k8s Node objects. */
async function getNodePublicIPv6(clients: KubeClients): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const nodes = await clients.core.listNode();
  for (const node of nodes.items) {
    const name = node.metadata?.name;
    if (!name) continue;
    for (const addr of node.status?.addresses ?? []) {
      // ExternalIP that is a global IPv6 (not ULA fd00::/8, not link-local fe80::/10)
      if (addr.type === "ExternalIP" && addr.address.includes(":") &&
          !addr.address.startsWith("fd") && !addr.address.startsWith("fe80")) {
        result.set(name, addr.address);
        break;
      }
    }
  }
  return result;
}

/** Configure BGP peering and advertisements. */
async function configureBGP(
  clients: KubeClients,
  bgp: BGPConfig,
  ipv4Address: string,
  ipv6Block: string,
): Promise<void> {
  log("metallb", `configuring BGP: myASN=${bgp.myASN} peerASN=${bgp.peerASN}`);

  // IPv4 BGP peer (cluster-wide — link-local peer, no source address issues)
  if (ipv4Address) {
    const peer4: Record<string, unknown> = {
      apiVersion: `${CRD_GROUP}/${CRD_VERSION_V2}`,
      kind: "BGPPeer",
      metadata: {
        name: "seed-bgp-ipv4",
        namespace: METALLB_NAMESPACE,
      },
      spec: {
        myASN: bgp.myASN,
        peerASN: bgp.peerASN,
        peerAddress: bgp.peerAddress,
        ebgpMultiHop: true,
        ...(bgp.password ? { password: bgp.password } : {}),
      },
    };

    await applyCustomResource(
      clients.custom,
      CRD_GROUP,
      CRD_VERSION_V2,
      METALLB_NAMESPACE,
      "bgppeers",
      "seed-bgp-ipv4",
      peer4,
    );
  }

  // IPv6 BGP peers — per-node with sourceAddress pinned to the node's
  // native public IPv6. This prevents FRR from auto-selecting a wrong
  // source address (e.g. a SLAAC address from the announced block).
  if (ipv6Block) {
    // Delete old cluster-wide IPv6 peer first — FRR mode rejects
    // duplicate peerAddress, so old peer must be gone before creating
    // per-node peers with the same peerAddress.
    try {
      await clients.custom.deleteNamespacedCustomObject({
        group: CRD_GROUP,
        version: CRD_VERSION_V2,
        namespace: METALLB_NAMESPACE,
        plural: "bgppeers",
        name: "seed-bgp-ipv6",
      });
      log("metallb", "removed old cluster-wide seed-bgp-ipv6 peer");
    } catch {
      // Doesn't exist, fine
    }

    const nodeIPs = await getNodePublicIPv6(clients);
    const peerNames: string[] = [];

    for (const [nodeName, ipv6] of nodeIPs) {
      const peerName = `seed-bgp-ipv6-${nodeName}`;
      peerNames.push(peerName);

      const peer6: Record<string, unknown> = {
        apiVersion: `${CRD_GROUP}/${CRD_VERSION_V2}`,
        kind: "BGPPeer",
        metadata: {
          name: peerName,
          namespace: METALLB_NAMESPACE,
        },
        spec: {
          myASN: bgp.myASN,
          peerASN: bgp.peerASN,
          peerAddress: bgp.peerAddressIPv6,
          sourceAddress: ipv6,
          ebgpMultiHop: true,
          nodeSelectors: [{ matchLabels: { "kubernetes.io/hostname": nodeName } }],
          ...(bgp.password ? { password: bgp.password } : {}),
        },
      };

      await applyCustomResource(
        clients.custom,
        CRD_GROUP,
        CRD_VERSION_V2,
        METALLB_NAMESPACE,
        "bgppeers",
        peerName,
        peer6,
      );
    }

    log("metallb", `configured ${peerNames.length} per-node IPv6 BGP peers`);
  }

  // BGP advertisement for the pool
  const advert = {
    apiVersion: `${CRD_GROUP}/${CRD_VERSION}`,
    kind: "BGPAdvertisement",
    metadata: {
      name: "seed-bgp",
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
    "bgpadvertisements",
    "seed-bgp",
    advert,
  );

  // Clean up old L2 advertisement if it exists
  try {
    await clients.custom.deleteNamespacedCustomObject({
      group: CRD_GROUP,
      version: CRD_VERSION,
      namespace: METALLB_NAMESPACE,
      plural: "l2advertisements",
      name: "seed-l2",
    });
    log("metallb", "removed old L2 advertisement");
  } catch {
    // Doesn't exist, that's fine
  }
}

/** Configure L2 advertisement (fallback when BGP is not configured). */
async function configureL2(clients: KubeClients): Promise<void> {
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
    const existing = await api.getNamespacedCustomObject({ group, version, namespace, plural, name }) as Record<string, unknown>;
    // Exists — update it, preserving resourceVersion
    const metadata = existing.metadata as Record<string, unknown> | undefined;
    const bodyMeta = (body.metadata || {}) as Record<string, unknown>;
    bodyMeta.resourceVersion = metadata?.resourceVersion;
    body.metadata = bodyMeta;
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
