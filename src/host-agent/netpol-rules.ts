// Pure rule building for netpol.ts: no iptables, no k8s, so it can be tested.
//
// Policy: a tenant pod may only reach other pods through k8s services (to
// their exposed ports), never by pod IP, whether the peer is in its own
// namespace or another one, on this node or another. The source node is the
// only place that can tell the two apart: kube-proxy DNATs on the source
// node, so a destination node sees service traffic from another node as plain
// pod-IP traffic. So the decision for traffic FROM a local tenant pod is made
// in its own namespace chain and is final; destination rules only see traffic
// from everything else (other nodes, LoadBalancer ingress, seed-system).

export const MAIN_CHAIN = "SEED-FWD";
export const OUT_CHAIN = "SEED-OUT";
export const IN_CHAIN = "SEED-IN";
export const EGRESS_CHAIN = "SEED-EGRESS-INET";

export interface ExposedPort {
  port: number;
  protocols: ("tcp" | "udp")[];
}

export interface RulePod {
  ips: string[];
  exposePorts: ExposedPort[];
}

export interface RuleConfig {
  serviceCidrs: string[];
  dnsIp: string;
}

export interface NamespaceRules {
  rules: string[][];   // namespace chain contents, in order
  outJumps: string[][]; // OUT_CHAIN rules: -s <ip> -j <chain>
  inJumps: string[][];  // IN_CHAIN rules: -d <ip> -j <chain>
}

const isV6 = (addr: string) => addr.includes(":");

/** Build one IP family's rules for a namespace's pods on this node. */
export function buildNamespaceRules(
  ns: string,
  chain: string,
  pods: RulePod[],
  cfg: RuleConfig,
  v6: boolean,
): NamespaceRules {
  const family = (addr: string) => isV6(addr) === v6;
  const dnsMatch = family(cfg.dnsIp);
  const svcCidrs = cfg.serviceCidrs.filter(family);
  const logPrefix = `SEED-DROP ${ns.slice(0, 12)}: `;
  const logRule = ["-j", "LOG", "--log-prefix", logPrefix, "-m", "limit", "--limit", "10/min"];

  const rules: string[][] = [];
  const outJumps: string[][] = [];
  const inJumps: string[][] = [];

  // Source side: one block per pod IP, ending in its own DROP so later
  // destination rules (another pod's exposed ports) never accept it.
  for (const pod of pods) {
    for (const ip of pod.ips.filter(family)) {
      // DNS — match on original destination (pre-DNAT) since kube-proxy
      // DNATs the service IP to the real coredns pod IP before FORWARD
      if (dnsMatch) {
        rules.push(["-s", ip, "-p", "udp", "--dport", "53",
          "-m", "conntrack", "--ctorigdst", cfg.dnsIp, "-j", "ACCEPT"]);
        rules.push(["-s", ip, "-p", "tcp", "--dport", "53",
          "-m", "conntrack", "--ctorigdst", cfg.dnsIp, "-j", "ACCEPT"]);
      }

      // Neighbor discovery with same-node peers. Conntrack doesn't track it,
      // so ESTABLISHED doesn't cover the unicast NS/NA between pods. Hop
      // limit 255 means it was sent on-link.
      if (v6) {
        for (const type of ["135", "136"]) {
          rules.push(["-s", ip, "-p", "ipv6-icmp", "--icmpv6-type", type,
            "-m", "hl", "--hl-eq", "255", "-j", "ACCEPT"]);
        }
      }

      // Services, any namespace (pre-DNAT original destination). This is the
      // only way to reach another pod.
      for (const cidr of svcCidrs) {
        rules.push(["-s", ip, "-m", "conntrack", "--ctorigdst", cidr, "-j", "ACCEPT"]);
      }

      // Internet (cluster CIDRs RETURN from the egress chain)
      rules.push(["-s", ip, "-j", EGRESS_CHAIN]);

      rules.push(["-s", ip, ...logRule]);
      rules.push(["-s", ip, "-j", "DROP"]);

      outJumps.push(["-s", ip, "-j", chain]);
    }
  }

  // Destination side: exposed ports. Traffic from local tenant pods never
  // gets here (OUT_CHAIN runs first and its blocks are terminal).
  for (const pod of pods) {
    for (const ip of pod.ips.filter(family)) {
      for (const ep of pod.exposePorts) {
        for (const proto of ep.protocols) {
          rules.push(["-d", ip, "-p", proto, "--dport", String(ep.port), "-j", "ACCEPT"]);
        }
      }
      inJumps.push(["-d", ip, "-j", chain]);
    }
  }

  // Default deny
  rules.push(logRule);
  rules.push(["-j", "DROP"]);

  return { rules, outJumps, inJumps };
}
