import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { VultrProvider } from "./providers/vultr.ts";
import type { NodeConfig } from "./types.ts";

const config = new pulumi.Config();
const provider = new VultrProvider();

// --- Configuration ---

const region = config.require("region");
const plan = config.require("plan");
const flakeUri = config.require("flakeUri");
const tangIp = config.require("tangIp");
const tangPort = config.require("tangPort");
const ipv4Address = config.require("ipv4Address");
const ipv6Block = config.require("ipv6Block");
const cacheBucket = config.require("cacheBucket");
const cacheEndpoint = config.require("cacheEndpoint");
const sshPubKeys = config.requireObject<string[]>("sshPubKeys");
const mynixDir = config.get("mynixDir") ?? "/agents/ada/projects/mynix";
const tangUrl = `http://${tangIp}:${tangPort}`;
// SSH proxy for reaching Tang/target hosts that are firewalled from signi
const sshProxy = config.get("sshProxy");

// --- Netboot init= path ---
//
// The netboot derivation is served from Tang's nix store via nginx (port 8080).
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

// --- Dynamic Provider for Node Provisioning ---
//
// Pulumi dynamic providers run arbitrary code during `pulumi up`.
// The provisioner calls nixos-anywhere, which is inherently imperative.
// We wrap it in a dynamic resource so Pulumi tracks the node state.

interface NodeProvisionerInputs {
  ip: pulumi.Input<string>;
  initNodeIp?: pulumi.Input<string>;
  nodeConfig: NodeConfig;
}

const nodeProvisionerProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Record<string, unknown>) {
    const ip = inputs["ip"] as string;
    const initNodeIp = inputs["initNodeIp"] as string | undefined;
    const nodeConfig = inputs["nodeConfig"] as NodeConfig;

    // Pass resolved initNodeIp into config for the orchestrator
    if (initNodeIp) {
      nodeConfig.initNodeIp = initNodeIp;
    }

    // Dynamic require to avoid serialization issues with native modules
    const { provisionNode: provision } = require("./orchestrate.ts");
    const result = provision(ip, nodeConfig);

    return {
      id: nodeConfig.name,
      outs: {
        agePublicKey: result.agePublicKey,
      },
    };
  },

  async diff(
    _id: string,
    _olds: Record<string, unknown>,
    _news: Record<string, unknown>
  ) {
    // Node provisioning is one-shot. Once installed, don't re-provision
    // unless the user explicitly destroys and recreates.
    return { changes: false };
  },
};

class NodeProvisioner extends pulumi.dynamic.Resource {
  public readonly agePublicKey!: pulumi.Output<string>;

  constructor(
    name: string,
    args: NodeProvisionerInputs,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(
      nodeProvisionerProvider,
      name,
      {
        agePublicKey: undefined,
        ...args,
      },
      opts
    );
  }
}

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

// --- iPXE Boot Script ---

// Chain-loads the NixOS netboot image from the Tang VM over HTTP.
// iPXE on Vultr can't validate Let's Encrypt TLS certs, so we serve
// netboot artifacts from Tang (port 8080) which speaks plain HTTP.
// init= points to the NixOS init binary inside the initrd (not a file on the server).
const ipxeScript = `#!ipxe
dhcp
set base http://${tangIp}:8080
kernel \${base}/bzImage init=${initPath} initrd=initrd nohibernate loglevel=4
initrd \${base}/initrd
boot
`;

const bootScript = provider.createBootScript("nixos-netboot", {
  content: ipxeScript,
  type: "pxe",
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

// --- Provision Nodes ---

// The init node bootstraps etcd; joining nodes need its IP for serverAddr.
const initNode = nodes.find((n) => n.clusterInit);
let initBm: ReturnType<typeof provider.createBareMetal> | undefined;

const nodeOutputs: Record<
  string,
  { ip: pulumi.Output<string>; ageKey: pulumi.Output<string> }
> = {};

for (const node of nodes) {
  // Create bare metal instance
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

  if (node.clusterInit) {
    initBm = bm;
  }

  // For joining nodes, derive serverAddr from the init node's IP
  const serverAddr =
    node.serverAddr ??
    (!node.clusterInit && initBm
      ? initBm.ipv4.apply((ip) => `https://${ip}:6443`)
      : undefined);

  // Orchestrate install via Pulumi dynamic provider.
  // LUKS passphrases are stored in mynix/secrets/luks-recovery.yaml
  // (sops-encrypted to josh's GPG + ada's age key). No Pulumi secrets needed.
  const provision = new NodeProvisioner(node.name, {
    ip: bm.ipv4,
    // Joining nodes need the init node's IP to fetch the k3s token
    initNodeIp: !node.clusterInit && initBm ? initBm.ipv4 : undefined,
    nodeConfig: {
      name: node.name,
      region,
      plan,
      flakeRef: `${flakeUri}#${node.name}`,
      tangUrl,
      sopsFile: `${mynixDir}/.sops.yaml`,
      mynixDir,
      clusterInit: node.clusterInit,
      serverAddr: node.serverAddr,
      sshProxy,
    },
  });

  nodeOutputs[node.name] = {
    ip: bm.ipv4,
    ageKey: provision.agePublicKey,
  };
}

// --- Exports ---

export const clusterInfo = {
  tangUrl,
  ipv4Address,
  ipv6Block,
  cacheBucket: `${cacheBucket}.${cacheEndpoint}`,
  nodeCount: nodes.length,
};

export const nodeIPs = Object.fromEntries(
  Object.entries(nodeOutputs).map(([name, out]) => [name, out.ip])
);
