import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { VultrProvider } from "./providers/vultr.ts";
import type { NodeConfig } from "./types.ts";
import type { TangProvisionConfig } from "./provision-tang.ts";

// Absolute paths for dynamic import() inside Pulumi dynamic providers.
// Dynamic providers serialize their create() functions — ESM doesn't have require(),
// so we use import() with absolute paths captured at module level.
const orchestratePath = resolve(process.cwd(), "orchestrate.ts");
const provisionTangPath = resolve(process.cwd(), "provision-tang.ts");

const config = new pulumi.Config();
const vultrConfig = new pulumi.Config("vultr");
const provider = new VultrProvider();

// --- Configuration ---

const region = config.require("region");
const plan = config.require("plan");
const flakeUri = config.require("flakeUri");
const tangPort = config.require("tangPort");
const cacheBucket = config.require("cacheBucket");
const cacheEndpoint = config.require("cacheEndpoint");
const sshPubKeys = config.requireObject<string[]>("sshPubKeys");
const mynixDir = config.get("mynixDir") ?? "/agents/ada/projects/mynix";
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
  tangUrl: pulumi.Input<string>;
  initNodeIp?: pulumi.Input<string>;
  vultrApiKey?: pulumi.Input<string>;
  vultrBmId?: pulumi.Input<string>;
  nodeConfig: NodeConfig;
}

const nodeProvisionerProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Record<string, unknown>) {
    const ip = inputs["ip"] as string;
    const resolvedTangUrl = inputs["tangUrl"] as string;
    const initNodeIp = inputs["initNodeIp"] as string | undefined;
    const vultrApiKey = inputs["vultrApiKey"] as string | undefined;
    const vultrBmId = inputs["vultrBmId"] as string | undefined;
    const nodeConfig = inputs["nodeConfig"] as NodeConfig;

    // Override tangUrl with the resolved value from tang VM
    nodeConfig.tangUrl = resolvedTangUrl;

    // Pass resolved inputs into config for the orchestrator
    if (initNodeIp) {
      nodeConfig.initNodeIp = initNodeIp;
    }
    if (vultrBmId) {
      nodeConfig.vultrBmId = vultrBmId;
    }

    // Dynamic import to avoid serialization issues with native modules.
    // ESM doesn't have require() — use import() with absolute path.
    const { provisionNode: provision } = await import(orchestratePath);
    const result = provision(ip, nodeConfig, vultrApiKey);

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

// --- Tang VM ---

// Tang NBDE server on VPC — provides disk encryption key escrow, netboot artifacts,
// and DNS resolution (unbound + pdns) for all seed nodes.
// OS ID 2136 = Debian 12 (base for nixos-anywhere).
const tangVm = provider.createVM("seed-tang-1", {
  region,
  plan: "vm-1c-2gb",
  label: "seed-tang-1",
  osId: 2136,
  enableIPv6: true,
  sshKeyIds,
  vpcId: vpc.id,
  tags: ["tang"],
});

const tangUrl = pulumi.interpolate`http://${tangVm.ipv4}:${tangPort}`;

// --- Tang Provisioner ---

const tangProvisionerProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Record<string, unknown>) {
    const ip = inputs["ip"] as string;
    const tangConfig = inputs["tangConfig"] as TangProvisionConfig;

    const { provisionTang } = await import(provisionTangPath);
    const result = provisionTang(ip, tangConfig);

    return {
      id: tangConfig.name,
      outs: { agePublicKey: result.agePublicKey },
    };
  },

  async diff() {
    return { changes: false };
  },
};

class TangProvisioner extends pulumi.dynamic.Resource {
  public readonly agePublicKey!: pulumi.Output<string>;

  constructor(
    name: string,
    args: { ip: pulumi.Input<string>; tangConfig: TangProvisionConfig },
    opts?: pulumi.CustomResourceOptions
  ) {
    super(tangProvisionerProvider, name, { agePublicKey: undefined, ...args }, opts);
  }
}

const tangProvision = new TangProvisioner("seed-tang-1", {
  ip: tangVm.ipv4,
  tangConfig: {
    name: "seed-tang-1",
    flakeRef: `${flakeUri}#seed-tang-1`,
    mynixDir,
  },
}, {
  parent: tangVm.resource,
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

// Chain-loads the NixOS netboot image from the Tang VM over HTTP.
// iPXE on Vultr can't validate Let's Encrypt TLS certs, so we serve
// netboot artifacts from Tang (port 8080) which speaks plain HTTP.
// init= points to the NixOS init binary inside the initrd (not a file on the server).
//
// Uses tangVm.ipv4 dynamically so the boot script updates when tang is reprovisioned.
const ipxeScript = tangVm.ipv4.apply((tangIp) => `#!ipxe
dhcp
set base http://${tangIp}:8080
kernel \${base}/bzImage init=${initPath} initrd=initrd nohibernate loglevel=4
initrd \${base}/initrd
boot
`);

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
  //
  // tangUrl is resolved from the tang VM's public IP. The NodeProvisioner's
  // dynamic provider receives it as a resolved string (Pulumi serializes Outputs).
  const provision = new NodeProvisioner(node.name, {
    ip: bm.ipv4,
    tangUrl,
    // Joining nodes need the init node's IP to fetch the k3s token
    initNodeIp: !node.clusterInit && initBm ? initBm.ipv4 : undefined,
    // Vultr API credentials for reinstalling BMs on PXE boot failure
    vultrApiKey: vultrConfig.requireSecret("apiKey"),
    vultrBmId: bm.id,
    nodeConfig: {
      name: node.name,
      region,
      plan,
      flakeRef: `${flakeUri}#${node.name}`,
      tangUrl: "", // placeholder — overridden by resolved tangUrl input
      sopsFile: `${mynixDir}/.sops.yaml`,
      mynixDir,
      clusterInit: node.clusterInit,
      serverAddr: node.serverAddr,
      sshProxy,
      cacheBucket,
      cacheEndpoint,
      cachePublicKey: "seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E=",
      reservedIpv4: reservedIpv4.address,
      reservedIpv6: reservedIpv6.block,
    },
  }, {
    parent: bm.resource,
    dependsOn: [tangProvision],
    // Alias the old URN (before parent was added) so Pulumi doesn't delete+create
    aliases: [{ parent: pulumi.rootStackResource }],
  });

  nodeOutputs[node.name] = {
    ip: bm.ipv4,
    ageKey: provision.agePublicKey,
  };
}

// --- Exports ---

export const clusterInfo = {
  tangUrl,
  tangPublicIp: tangVm.ipv4,
  tangVpcIp: tangVm.internalIp,
  ipv4Address: reservedIpv4.address,
  ipv6Block: reservedIpv6.block,
  cacheBucket: `${cacheBucket}.${cacheEndpoint}`,
  nodeCount: nodes.length,
};

export const nodeIPs = Object.fromEntries(
  Object.entries(nodeOutputs).map(([name, out]) => [name, out.ip])
);
