import * as pulumi from "@pulumi/pulumi";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { VultrProvider } from "./providers/vultr.js";
import { provisionNode } from "./orchestrate.js";
import type { NodeConfig } from "./types.js";

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
const netbootBucket = config.require("netbootBucket");
const sshPubKeys = config.requireObject<string[]>("sshPubKeys");
const mynixDir = config.get("mynixDir") ?? "/agents/ada/projects/mynix";
const tangUrl = `http://${tangIp}:${tangPort}`;

// --- Dynamic Provider for Node Provisioning ---
//
// Pulumi dynamic providers run arbitrary code during `pulumi up`.
// The provisioner calls nixos-anywhere, which is inherently imperative.
// We wrap it in a dynamic resource so Pulumi tracks the node state.

interface NodeProvisionerInputs {
  ip: pulumi.Input<string>;
  nodeConfig: NodeConfig;
}

const nodeProvisionerProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Record<string, unknown>) {
    const ip = inputs["ip"] as string;
    const nodeConfig = inputs["nodeConfig"] as NodeConfig;

    const result = provisionNode(ip, nodeConfig);

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

// --- Netboot Image Builder + S3 Uploader ---
//
// Builds the NixOS netboot image (kernel + initrd) from the seed flake,
// then uploads artifacts to the public netboot S3 bucket. The init= path
// is extracted from the generated iPXE script and used in the Vultr boot script.

interface NetbootArtifactsInputs {
  s3Hostname: pulumi.Input<string>;
  s3AccessKey: pulumi.Input<string>;
  s3SecretKey: pulumi.Input<string>;
  bucket: string;
}

function buildAndUpload(inputs: Record<string, unknown>) {
  const s3Hostname = inputs["s3Hostname"] as string;
  const accessKey = inputs["s3AccessKey"] as string;
  const secretKey = inputs["s3SecretKey"] as string;
  const bucket = inputs["bucket"] as string;

  // Build netboot artifacts from the seed flake (parent of infra/)
  const seedFlake = path.resolve(process.cwd(), "..");
  const outPath = execSync(
    `nix build "path:${seedFlake}#netboot" --print-out-paths --no-link`,
    { encoding: "utf8", timeout: 600_000 }
  ).trim();

  // Extract init= path from the generated iPXE script
  const ipxeContent = readFileSync(`${outPath}/netboot.ipxe`, "utf8");
  const initMatch = ipxeContent.match(/init=(\S+)/);
  if (!initMatch) {
    throw new Error("Could not parse init= path from netboot.ipxe");
  }
  const initPath = initMatch[1];

  // Upload kernel + initrd to S3 (public-read for iPXE access)
  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: accessKey,
    AWS_SECRET_ACCESS_KEY: secretKey,
  };
  const s3Base = `s3://${bucket}`;
  const endpoint = `https://${s3Hostname}`;

  execSync(
    `nix shell nixpkgs#awscli2 -c aws s3 cp "${outPath}/bzImage" "${s3Base}/bzImage" ` +
      `--endpoint-url "${endpoint}" --acl public-read`,
    { env, encoding: "utf8", timeout: 300_000 }
  );
  execSync(
    `nix shell nixpkgs#awscli2 -c aws s3 cp "${outPath}/initrd" "${s3Base}/initrd" ` +
      `--endpoint-url "${endpoint}" --acl public-read`,
    { env, encoding: "utf8", timeout: 300_000 }
  );

  return {
    id: "netboot-artifacts",
    outs: {
      initPath,
      storePath: outPath,
    },
  };
}

const netbootArtifactsProvider: pulumi.dynamic.ResourceProvider = {
  async create(inputs: Record<string, unknown>) {
    return buildAndUpload(inputs);
  },

  async update(
    _id: string,
    _olds: Record<string, unknown>,
    news: Record<string, unknown>
  ) {
    return buildAndUpload(news);
  },

  async diff(
    _id: string,
    olds: Record<string, unknown>,
    _news: Record<string, unknown>
  ) {
    // Compare the current nix store path (content-addressed) against the
    // one that was uploaded. --refresh ensures we pick up flake input changes.
    try {
      const seedFlake = path.resolve(process.cwd(), "..");
      const currentPath = execSync(
        `nix build "path:${seedFlake}#netboot" --print-out-paths --no-link --refresh`,
        { encoding: "utf8", timeout: 600_000 }
      ).trim();
      return { changes: currentPath !== olds["storePath"] };
    } catch {
      // If the build fails during preview, don't block — skip the diff.
      return { changes: false };
    }
  },
};

class NetbootArtifacts extends pulumi.dynamic.Resource {
  public readonly initPath!: pulumi.Output<string>;
  public readonly storePath!: pulumi.Output<string>;

  constructor(
    name: string,
    args: NetbootArtifactsInputs,
    opts?: pulumi.CustomResourceOptions
  ) {
    super(
      netbootArtifactsProvider,
      name,
      {
        initPath: undefined,
        storePath: undefined,
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

// --- Netboot Bucket ---

// Separate public bucket for netboot artifacts (kernel + initrd).
// The nix cache bucket stays private (S3 protocol, no public HTTPS).
const netboot = provider.createObjectStorage("seed-netboot", {
  region,
  label: netbootBucket,
});

// --- Netboot Build + Upload ---

// Build the NixOS netboot image from the seed flake and upload kernel + initrd
// to the public S3 bucket. The init= kernel parameter is extracted from the
// nix-generated iPXE script (it contains the /nix/store/...-nixos-system-.../init path).
const netbootArtifacts = new NetbootArtifacts("netboot-artifacts", {
  s3Hostname: netboot.s3Hostname,
  s3AccessKey: netboot.s3AccessKey,
  s3SecretKey: netboot.s3SecretKey,
  bucket: netbootBucket,
});

// --- iPXE Boot Script ---

// Chain-loads the NixOS netboot image from the public bucket.
// init= points to the NixOS init binary inside the initrd (not a file on S3).
const ipxeScript = pulumi
  .all([netboot.s3Hostname, netbootArtifacts.initPath])
  .apply(
    ([hostname, initPath]) => `#!ipxe
dhcp
set base https://${hostname}/${netbootBucket}
kernel \${base}/bzImage init=${initPath} loglevel=4
initrd \${base}/initrd
boot
`
  );

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
  netbootEndpoint: netboot.s3Hostname,
  nodeCount: nodes.length,
};

export const nodeIPs = Object.fromEntries(
  Object.entries(nodeOutputs).map(([name, out]) => [name, out.ip])
);
