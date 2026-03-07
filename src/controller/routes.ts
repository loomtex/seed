// IPv4/IPv6 LoadBalancer service generation for public ingress routes.

import type * as k8s from "@kubernetes/client-node";
import { seedLabels, LABELS, ANNOTATIONS } from "../shared/labels.js";
import type { IPv4Config, IPv4Route, IPv6Config, IPv6Route } from "../shared/types.js";

/** Generate LoadBalancer services for IPv4 routes. */
export function generateIPv4Services(
  config: IPv4Config,
  ipv4Address: string,
  generation: string,
  namespace: string,
): k8s.V1Service[] {
  if (!config.enable || !ipv4Address) return [];

  // Group routes by instance
  const byInstance = new Map<string, { key: string; route: IPv4Route }[]>();
  for (const [key, route] of Object.entries(config.routes)) {
    const list = byInstance.get(route.instance) || [];
    list.push({ key, route });
    byInstance.set(route.instance, list);
  }

  const services: k8s.V1Service[] = [];

  for (const [instance, entries] of byInstance) {
    const ports: k8s.V1ServicePort[] = [];

    for (const { key, route } of entries) {
      const targetPort = route.targetPort ?? route.port;
      addProtocolPorts(ports, key, route.port, targetPort, route.protocol);
    }

    services.push(
      generateLBService(
        `seed-${instance}-ipv4`,
        instance,
        generation,
        namespace,
        ipv4Address,
        ports,
        "ipv4",
      ),
    );
  }

  return services;
}

/** Generate LoadBalancer services for IPv6 routes. */
export function generateIPv6Services(
  config: IPv6Config,
  generation: string,
  namespace: string,
): k8s.V1Service[] {
  if (!config.enable || !config.block) return [];

  // Strip prefix length, keep the :: base
  const blockPrefix = config.block.replace(/\/\d+$/, "").replace(/::$/, "::");

  const services: k8s.V1Service[] = [];

  for (const [key, route] of Object.entries(config.routes)) {
    const lbIP = `${blockPrefix}${route.host}`;
    const targetPort = route.targetPort ?? route.port;
    const ports: k8s.V1ServicePort[] = [];
    addProtocolPorts(ports, key, route.port, targetPort, route.protocol);

    services.push(
      generateLBService(
        `seed-${key}-ipv6`,
        route.instance,
        generation,
        namespace,
        lbIP,
        ports,
        "ipv6",
      ),
    );
  }

  return services;
}

/** Generate a LoadBalancer service manifest. */
function generateLBService(
  name: string,
  instance: string,
  generation: string,
  namespace: string,
  loadBalancerIP: string,
  ports: k8s.V1ServicePort[],
  serviceType: "ipv4" | "ipv6",
): k8s.V1Service {
  const ipFamily = serviceType === "ipv6" ? "IPv6" : "IPv4";

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: {
      name,
      namespace,
      labels: {
        ...seedLabels(instance, generation),
        [LABELS.SERVICE_TYPE]: serviceType,
      },
      annotations: {
        [ANNOTATIONS.ADDRESS_POOL]: "seed-pool",
        [ANNOTATIONS.ALLOW_SHARED_IP]: `seed-${serviceType}`,
      },
    },
    spec: {
      type: "LoadBalancer",
      loadBalancerIP,
      ipFamilyPolicy: "SingleStack",
      ipFamilies: [ipFamily],
      externalTrafficPolicy: "Cluster",
      selector: { "seed.loom.farm/instance": instance },
      ports,
    },
  };
}

/** Add ports for a given protocol (DNS = both TCP + UDP). */
function addProtocolPorts(
  ports: k8s.V1ServicePort[],
  key: string,
  port: number,
  targetPort: number,
  protocol: string,
): void {
  switch (protocol) {
    case "dns":
      ports.push(
        { name: `${key}-tcp`, port, targetPort, protocol: "TCP" },
        { name: `${key}-udp`, port, targetPort, protocol: "UDP" },
      );
      break;
    case "udp":
      ports.push({ name: key, port, targetPort, protocol: "UDP" });
      break;
    default:
      ports.push({ name: key, port, targetPort, protocol: "TCP" });
      break;
  }
}
