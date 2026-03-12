import * as pulumi from "@pulumi/pulumi";
import { VultrProvider } from "./providers/vultr.ts";
import type { ClusterManifest } from "./types.ts";

// Pulumi program: pure resource CRUD. No imperative provisioning logic.
// Creates VPC, VMs, BMs, IPs, boot scripts. Outputs a manifest for
// the provision-cluster script to consume.
//
// Two-phase deployment:
//   Phase 1: stakeIp not set → creates VPC, SSH keys, reserved IPs only
//   Phase 2: stakeIp set     → creates boot script, puncher VM, BM nodes

const config = new pulumi.Config();
const provider = new VultrProvider();

// --- Configuration ---

const region = config.require("region");
const plan = config.require("plan");
const flakeUri = config.require("flakeUri");
const puncherPort = Number(config.require("puncherPort"));
const sshPubKeys = config.requireObject<string[]>("sshPubKeys");
const mynixDir = config.get("mynixDir") ?? "/agents/ada/projects/mynix";
const stakeIp = config.get("stakeIp"); // Optional — VPC IP, set after stake joins VPC
const stakePublicIp = config.get("stakePublicIp"); // Optional — public IP for iPXE netboot
const puncherVpcIp = config.get("puncherVpcIp"); // Deterministic VPC IP for puncher (Vultr VPC v1 has no DHCP)

// --- SSH Keys ---

const sshKeys = sshPubKeys.map((key, i) => {
  const comment = key.split(" ").slice(2).join(" ") || `key-${i}`;
  const name = comment.replace(/[^a-zA-Z0-9-]/g, "-");
  return provider.createSSHKey(`ssh-${name}`, key);
});
const sshKeyIds = sshKeys.map((k) => k.id);

// --- VPC ---

// Private network for cluster-internal traffic (etcd, flannel, kubelet, Tang).
// Created in phase 1 so provision.sh can attach the stake VM before phase 2.
const vpc = provider.createVPC("seed-vpc", {
  region,
  description: "Seed cluster internal network",
  subnet: "10.0.0.0",
  subnetMask: 24,
});

// --- Reserved IPs ---
// TODO: uncomment when Vultr reserved IP quota clears
//
// // Public IPv4 for LoadBalancer services (MetalLB L2 advertisement).
// const reservedIpv4 = provider.reserveIPv4("seed-ipv4", {
//   region,
//   label: "seed-atl",
// });
//
// // Public /64 IPv6 block for LoadBalancer services (MetalLB NDP advertisement).
// const reservedIpv6 = provider.reserveIPv6Block("seed-ipv6", {
//   region,
//   prefix: 64,
//   label: "seed-atl",
// });

// --- Phase 1 exports (always available) ---

export const vpcId = vpc.id;

// --- Phase 2: machines (only when stakeIp is set) ---

function createMachines(stakeIp: string, stakePublicIp: string) {
  // --- iPXE Boot Script ---
  //
  // Chainloads the netboot.ipxe served by the stake's nginx (port 8080).
  // The stake's NixOS config builds the netboot derivation (kernel, initrd,
  // netboot.ipxe with the correct init= path) as a single unit. By chainloading
  // instead of extracting init= from a separate nix build, we guarantee the
  // kernel, initrd, and init= all come from the same derivation.
  //
  // The netboot.ipxe template includes ${cmdline} on the kernel line, which
  // picks up the phone_home= parameter we set here.
  //
  // Both the PXE download and phone_home use the public IP because the NixOS
  // installer doesn't have the VPC interface configured (Vultr VPC v1 has no DHCP,
  // and the installer can't statically assign VPC IPs).

  const ipxeScript = `#!ipxe
dhcp
set cmdline phone_home=http://${stakePublicIp}:8081/register
chain http://${stakePublicIp}:8080/netboot.ipxe
`;

  const bootScript = provider.createBootScript("nixos-netboot", {
    content: ipxeScript,
    type: "pxe",
  });

  // --- Puncher VM ---
  //
  // Tang NBDE + DNS + management host on VPC. Boots Debian, then
  // provision-cluster.ts runs nixos-anywhere to install NixOS.
  // (iPXE boot with our ~500MB initrd doesn't work on Vultr BIOS VMs)
  const puncherVm = provider.createVM("seed-puncher-1", {
    region,
    plan: "vm-1c-2gb",
    label: "seed-puncher-1",
    osId: 2136, // Debian 12
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
    vpcIp?: string;
  }

  const nodes = config.getObject<NodeDef[]>("nodes") ?? [];

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
      internalIp: bm.ipv4,
    };
  }

  // --- Manifest ---

  const manifest = pulumi.all([
    puncherVm.ipv4,
    puncherVm.internalIp,
    ...nodes.map((n) => bmOutputs[n.name].ip),
    ...nodes.map((n) => bmOutputs[n.name].id),
  ]).apply(([puncherIp, puncherInternalIp, ...rest]) => {
    const nodeIps = rest.slice(0, nodes.length) as string[];
    const nodeIds = rest.slice(nodes.length) as string[];

    const m: ClusterManifest = {
      puncher: {
        name: "seed-puncher-1",
        ip: puncherIp,
        internalIp: puncherVpcIp ?? puncherInternalIp, // Prefer deterministic VPC IP over Vultr-assigned
        flakeRef: `${flakeUri}#seed-puncher-1`,
      },
      nodes: nodes.map((n, i) => ({
        name: n.name,
        ip: nodeIps[i],
        internalIp: n.vpcIp ?? nodeIps[i], // Prefer deterministic VPC IP over public IP
        clusterInit: n.clusterInit,
        bmId: nodeIds[i],
        flakeRef: `${flakeUri}#${n.name}`,
      })),
      reservedIpv4: "", // TODO: restore when IP quota clears
      reservedIpv6: "", // TODO: restore when IP quota clears
      puncherPort,
      mynixDir,
      sopsFile: `${mynixDir}/.sops.yaml`,
    };
    return m;
  });

  return {
    manifest,
    clusterInfo: {
      puncherPublicIp: puncherVm.ipv4,
      puncherVpcIp: puncherVm.internalIp,
      ipv4Address: "", // TODO: restore
      ipv6Block: "",   // TODO: restore
      nodeCount: nodes.length,
    },
    nodeIPs: Object.fromEntries(
      Object.entries(bmOutputs).map(([name, out]) => [name, out.ip])
    ),
  };
}

// Phase 2 outputs — only populated when stakeIp is set
const machines = stakeIp ? createMachines(stakeIp, stakePublicIp ?? stakeIp) : undefined;
export const manifest = machines?.manifest;
export const clusterInfo = machines?.clusterInfo;
export const nodeIPs = machines?.nodeIPs;
