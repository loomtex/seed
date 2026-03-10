import * as pulumi from "@pulumi/pulumi";

// Provider-agnostic interfaces for seed cluster infrastructure.
// Implementations live in providers/ (e.g. providers/vultr.ts).

export interface SeedProvider {
  createBareMetal(name: string, args: BareMetalArgs): BareMetal;
  createVM(name: string, args: VMArgs): VM;
  createVPC(name: string, args: VPCArgs): VPC;
  reserveIPv4(name: string, args: ReserveIPArgs): ReservedIPv4;
  reserveIPv6Block(name: string, args: ReserveIPv6Args): ReservedIPv6;
  createObjectStorage(name: string, args: StorageArgs): ObjectBucket;
  createBootScript(name: string, args: BootScriptArgs): BootScript;
  uploadObject(bucket: ObjectBucket, key: string, content: pulumi.Input<string>): void;
  createSSHKey(name: string, publicKey: pulumi.Input<string>): SSHKey;
}

// --- Bare Metal ---

export interface BareMetalArgs {
  region: string;
  plan: string;
  label: string;
  bootScriptId: pulumi.Input<string>;
  enableIPv6: boolean;
  sshKeyIds?: pulumi.Input<string>[];
  vpcId?: pulumi.Input<string>;
  tags?: string[];
}

export interface BareMetal {
  id: pulumi.Output<string>;
  ipv4: pulumi.Output<string>;
  ipv6: pulumi.Output<string>;
  label: pulumi.Output<string>;
  resource: pulumi.Resource; // underlying Pulumi resource (for parent/dependsOn)
}

// --- Virtual Machine ---

export interface VMArgs {
  region: string;
  plan: string;
  label: string;
  osId: number;
  enableIPv6?: boolean;
  sshKeyIds?: pulumi.Input<string>[];
  tags?: string[];
}

export interface VM {
  id: pulumi.Output<string>;
  ipv4: pulumi.Output<string>;
  ipv6: pulumi.Output<string>;
  label: pulumi.Output<string>;
}

// --- Reserved IPs ---

export interface ReserveIPArgs {
  region: string;
  label: string;
}

export interface ReservedIPv4 {
  id: pulumi.Output<string>;
  address: pulumi.Output<string>;
}

export interface ReserveIPv6Args {
  region: string;
  prefix: number; // e.g. 64
  label?: string;
}

export interface ReservedIPv6 {
  id: pulumi.Output<string>;
  block: pulumi.Output<string>;
}

// --- Object Storage ---

export interface StorageArgs {
  region: string;
  label: string;
  clusterId?: number;
  tierId?: number;
}

export interface ObjectBucket {
  id: pulumi.Output<string>;
  label: pulumi.Output<string>;
  endpoint: pulumi.Output<string>;
  s3Hostname: pulumi.Output<string>;
  s3AccessKey: pulumi.Output<string>;
  s3SecretKey: pulumi.Output<string>;
}

// --- VPC ---

export interface VPCArgs {
  region: string;
  description?: string;
  subnet: string;     // e.g. "10.0.0.0"
  subnetMask: number; // e.g. 24
}

export interface VPC {
  id: pulumi.Output<string>;
}

// --- Boot Script ---

export interface BootScriptArgs {
  content: pulumi.Input<string>;
  type: "boot" | "pxe";
}

export interface BootScript {
  id: pulumi.Output<string>;
}

// --- SSH Key ---

export interface SSHKey {
  id: pulumi.Output<string>;
}

// --- Node Configuration ---

export interface NodeConfig {
  name: string;
  region: string;
  plan: string;
  flakeRef: string; // e.g. "github:joshperry/mynix#seed-dfw-1"
  tangUrl: string;
  sopsFile: string; // path to mynix .sops.yaml
  mynixDir: string; // path to mynix repo root
  clusterInit?: boolean;
  serverAddr?: string;
  initNodeIp?: string; // IP of the init node (for fetching k3s token on joining nodes)
  sshProxy?: string; // SSH host to proxy Tang/target connections through (e.g. "root@seed-dfw-1")
  cacheBucket?: string;   // S3 bucket name for binary cache (e.g. "seed-nix-cache")
  cacheEndpoint?: string; // S3 endpoint hostname (e.g. "atl2.vultrobjects.com")
  cachePublicKey?: string; // nix public key for the cache (e.g. "seed-cache-1:...")
  reservedIpv4?: string;  // Cluster's reserved IPv4 (for controller ConfigMap + joining node serverAddr)
  reservedIpv6?: string;  // Cluster's reserved IPv6 block (for controller ConfigMap)
}
