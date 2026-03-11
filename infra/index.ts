import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { VultrProvider } from "./providers/vultr.ts";
import type { ClusterManifest } from "./types.ts";

// Pulumi program: pure resource CRUD. No imperative provisioning logic.
// Creates VPC, VMs, BMs, IPs, boot scripts. Outputs a manifest for
// the provision-cluster script to consume.

const config = new pulumi.Config();
const provider = new VultrProvider();

// --- Configuration ---

const region = config.require("region");
const plan = config.require("plan");
const flakeUri = config.require("flakeUri");
const puncherPort = Number(config.require("puncherPort"));
const sshPubKeys = config.requireObject<string[]>("sshPubKeys");
const mynixDir = config.get("mynixDir") ?? "/agents/ada/projects/mynix";
const stakeIp = config.require("stakeIp");

// --- Netboot init= path ---
//
// The netboot derivation is served from stake's nix store via nginx (port 8080).
// We only need the init= kernel parameter, which we extract from the nix-built
// iPXE script. This runs at Pulumi eval time (not in a dynamic provider).

const seedFlake = resolve(process.cwd(), "..");
const netbootPath = execSync(
  `nix build "path:${seedFlake}#netboot" --print-out-paths --no-link`,
  { encoding: "utf8", timeout: 600_000 }
).trim();

const ipxeContent = readFileSync(`${netbootPath}/netboot.ipxe`, "utf8");
const initMatch = ipxeContent.match(/init=(\S+)/);
if (!initMatch) {
  throw new Error("Could not parse init= path from netboot.ipxe");
}
const initPath = initMatch[1];

// --- SSH Keys ---

const sshKeys = sshPubKeys.map((key, i) => {
  const comment = key.split(" ").slice(2).join(" ") || `key-${i}`;
  const name = comment.replace(/[^a-zA-Z0-9-]/g, "-");
  return provider.createSSHKey(`ssh-${name}`, key);
});
const sshKeyIds = sshKeys.map((k) => k.id);

// --- VPC ---

// Private network for cluster-internal traffic (etcd, flannel, kubelet).
// Public interfaces are firewalled to SSH + LoadBalancer ports only.
const vpc = provider.createVPC("seed-vpc", {
  region,
  description: "Seed cluster internal network",
  subnet: "10.0.0.0",
  subnetMask: 24,
});

// --- Reserved IPs ---

// Public IPv4 for LoadBalancer services (MetalLB L2 advertisement).
// Attached to one node; MetalLB handles ARP for all services.
const reservedIpv4 = provider.reserveIPv4("seed-ipv4", {
  region,
  label: "seed-atl",
});

// Public /64 IPv6 block for LoadBalancer services (MetalLB NDP advertisement).
// Each service gets a unique address from this block.
const reservedIpv6 = provider.reserveIPv6Block("seed-ipv6", {
  region,
  prefix: 64,
  label: "seed-atl",
});

// --- iPXE Boot Script ---
//
// Chain-loads the NixOS netboot image from the stake VM over HTTP.
// iPXE on Vultr can't validate Let's Encrypt TLS certs, so we serve
// netboot artifacts from stake (port 8080) which speaks plain HTTP.
// init= points to the NixOS init binary inside the initrd (not a file on the server).
// phone_home= tells the netboot installer where to register itself.

const ipxeScript = `#!ipxe
dhcp
set base http://${stakeIp}:8080
kernel \${base}/bzImage init=${initPath} phone_home=http://${stakeIp}:8081/register initrd=initrd nohibernate loglevel=4
initrd \${base}/initrd
boot
`;

const bootScript = provider.createBootScript("nixos-netboot", {
  content: ipxeScript,
  type: "pxe",
});

// --- Puncher VM ---
//
// Tang NBDE + DNS + management host on VPC. iPXE boots from stake like BMs.
// OS ID 159 = Custom (iPXE boot via bootScriptId).
const puncherVm = provider.createVM("seed-puncher-1", {
  region,
  plan: "vm-1c-2gb",
  label: "seed-puncher-1",
  osId: 159, // overridden by bootScriptId in vultr.ts
  bootScriptId: bootScript.id,
  enableIPv6: true,
  sshKeyIds,
  vpcId: vpc.id,
  tags: ["puncher"],
});

// --- Node Definitions ---

interface NodeDef {
  name: string;
  clusterInit?: boolean;
  serverAddr?: string;
}

// Node definitions from stack config, or defaults for the current cluster.
// The first node with clusterInit bootstraps embedded etcd; others join via serverAddr.
const nodes = config.getObject<NodeDef[]>("nodes") ?? [
  { name: "seed-atl-1", clusterInit: true },
  { name: "seed-atl-2" },
  { name: "seed-atl-3" },
];

// --- Create Bare Metal Nodes ---

const bmOutputs: Record<
  string,
  { ip: pulumi.Output<string>; id: pulumi.Output<string>; internalIp: pulumi.Output<string> }
> = {};

for (const node of nodes) {
  const bm = provider.createBareMetal(node.name, {
    region,
    plan,
    label: node.name,
    bootScriptId: bootScript.id,
    enableIPv6: true,
    sshKeyIds,
    vpcId: vpc.id,
    tags: ["seed"],
  });

  bmOutputs[node.name] = {
    ip: bm.ipv4,
    id: bm.id,
    internalIp: bm.ipv4, // BMs don't have separate internal IPs on Vultr VPC
  };
}

// --- Manifest Output ---
//
// Structured output consumed by provision-cluster.ts.
// Contains everything needed to match phone-home registrations
// to expected machines and provision them in the right order.

export const manifest = pulumi.all([
  puncherVm.ipv4,
  puncherVm.internalIp,
  reservedIpv4.address,
  reservedIpv6.block,
  ...nodes.map((n) => bmOutputs[n.name].ip),
  ...nodes.map((n) => bmOutputs[n.name].id),
]).apply(([puncherIp, puncherInternalIp, ipv4Addr, ipv6Block, ...rest]) => {
  const nodeIps = rest.slice(0, nodes.length) as string[];
  const nodeIds = rest.slice(nodes.length) as string[];

  const m: ClusterManifest = {
    puncher: {
      name: "seed-puncher-1",
      ip: puncherIp,
      internalIp: puncherInternalIp,
      flakeRef: `${flakeUri}#seed-puncher-1`,
    },
    nodes: nodes.map((n, i) => ({
      name: n.name,
      ip: nodeIps[i],
      internalIp: nodeIps[i],
      clusterInit: n.clusterInit,
      bmId: nodeIds[i],
      flakeRef: `${flakeUri}#${n.name}`,
    })),
    reservedIpv4: ipv4Addr,
    reservedIpv6: ipv6Block,
    puncherPort,
    mynixDir,
    sopsFile: `${mynixDir}/.sops.yaml`,
  };
  return m;
});

// --- Exports ---

export const clusterInfo = {
  puncherPublicIp: puncherVm.ipv4,
  puncherVpcIp: puncherVm.internalIp,
  ipv4Address: reservedIpv4.address,
  ipv6Block: reservedIpv6.block,
  nodeCount: nodes.length,
};

export const nodeIPs = Object.fromEntries(
  Object.entries(bmOutputs).map(([name, out]) => [name, out.ip])
);
