// Shared type definitions for seed controller components.

import type * as k8s from "@kubernetes/client-node";

// --- SeedHostTask CRD ---

export interface SeedHostTaskSpec {
  type: "swtpm";
  instance: string;
  namespace: string;
}

export interface SeedHostTaskStatus {
  ready: boolean;
  socketPath: string;
  message: string;
}

export interface SeedHostTask {
  apiVersion: "seed.loom.farm/v1alpha1";
  kind: "SeedHostTask";
  metadata: k8s.V1ObjectMeta;
  spec: SeedHostTaskSpec;
  status?: SeedHostTaskStatus;
}

// --- Instance metadata (from nix eval) ---

export interface SeedResources {
  vcpus: number;
  memory: number;
}

export interface SeedExposeEntry {
  port: number;
  protocol: "tcp" | "udp" | "dns" | "http" | "grpc";
}

export interface SeedStorageEntry {
  size: string;
  mountPoint: string;
}

export interface SeedConnectEntry {
  service: string;
  port: number | null;
}

export interface SeedShootConfig {
  enable: boolean;
}

export interface SeedDnsConfig {
  names?: string[];
}

export interface SeedMeta {
  name: string;
  namespace?: string | null;
  system: string;
  size: string;
  resources: SeedResources;
  expose: Record<string, SeedExposeEntry>;
  storage: Record<string, SeedStorageEntry>;
  connect: Record<string, SeedConnectEntry>;
  rollout?: "recreate" | "rolling";
  acme?: boolean;
  shoot?: SeedShootConfig;
  dns?: SeedDnsConfig;
}

// --- Route blocks (from nix eval of flake outputs) ---

export interface IPv4Route {
  port: number;
  protocol: "tcp" | "udp" | "dns" | "http" | "grpc";
  instance: string;
  targetPort?: number;
}

export interface IPv4Config {
  enable: boolean;
  routes: Record<string, IPv4Route>;
}

export interface IPv6Route {
  host: string;
  port: number;
  protocol: "tcp" | "udp" | "dns" | "http" | "grpc";
  instance: string;
  targetPort?: number;
}

export interface IPv6Config {
  enable: boolean;
  block: string;
  routes: Record<string, IPv6Route>;
}

// --- Desired state ---

export interface InstanceState {
  imagePath: string;
  meta: SeedMeta;
  deployment: k8s.V1Deployment;
  services: k8s.V1Service[];
  ingressService: k8s.V1Service | null;
  pvcs: k8s.V1PersistentVolumeClaim[];
  hostTask: SeedHostTask | null;
  dnsRecords: SeedDNSRecord[];
}

export interface DesiredState {
  generation: string;
  namespace: string;
  instances: Map<string, InstanceState>;
  routes: {
    ipv4: k8s.V1Service[];
    ipv6: k8s.V1Service[];
  };
  domains: SeedDomain[];
}

// --- Builder Job result (stored in ConfigMap) ---

export interface BuildResult {
  imagePath: string;
  meta: SeedMeta;
}

// --- SeedFlake CRD ---

export interface SeedFlakeSpec {
  inviteCode: string;
  flakeUri: string;
  identity: string;
}

export interface SeedFlakeStatus {
  namespace: string;
  state: "pending" | "active";
  generation: string;
  lastReconciled: string;
}

export interface SeedFlake {
  apiVersion: "seed.loom.farm/v1alpha1";
  kind: "SeedFlake";
  metadata: k8s.V1ObjectMeta;
  spec: SeedFlakeSpec;
  status?: SeedFlakeStatus;
}

// --- combine.domains (from nix eval) ---

export interface CombineDomainConfig {
  register: boolean;
  default: boolean;
}

export interface CombineConfig {
  domains: Record<string, CombineDomainConfig>;
}

// --- SeedDomain CRD ---

export type SeedDomainPhase =
  | "Pending"
  | "Registering"
  | "Registered"
  | "Delegating"
  | "Delegated"
  | "ZoneReady"
  | "Error";

export interface SeedDomainSpec {
  name: string;
  register: boolean;
  registrar?: "namesilo";
}

export interface SeedDomainStatus {
  phase: SeedDomainPhase;
  registered: boolean;
  nsConfigured: boolean;
  zoneReady: boolean;
  registrarDomainId?: string;
  expiresAt?: string;
  message: string;
  lastSyncedAt: string;
}

export interface SeedDomain {
  apiVersion: "seed.loom.farm/v1alpha1";
  kind: "SeedDomain";
  metadata: k8s.V1ObjectMeta;
  spec: SeedDomainSpec;
  status?: SeedDomainStatus;
}

// --- SeedDNSRecord CRD ---

export interface SeedDNSRecordSourceRef {
  kind: "Service";
  name: string;
}

export interface SeedDNSRecordSpec {
  name: string;
  type: "A" | "AAAA" | "CNAME";
  ttl: number;
  records?: { content: string }[];
  sourceRef?: SeedDNSRecordSourceRef;
  domainRef?: { name: string };
}

export interface SeedDNSRecordStatus {
  synced: boolean;
  resolvedRecords?: { content: string }[];
  message: string;
  lastSyncedAt: string;
}

export interface SeedDNSRecord {
  apiVersion: "seed.loom.farm/v1alpha1";
  kind: "SeedDNSRecord";
  metadata: k8s.V1ObjectMeta;
  spec: SeedDNSRecordSpec;
  status?: SeedDNSRecordStatus;
}

// --- Controller configuration ---

export interface ControllerConfig {
  flakePaths: string[];
  ipv4Address: string;
  ipv6Block: string;
  webhookSecretFile: string;
  builderImage: string;
  poolManagerUrl: string;
  swtpmEnabled: boolean;
  pdnsApiUrl: string;
  pdnsApiKeyFile: string;
  pdnsZone: string;
  instanceDomain: string;
  acmeEnabled: boolean;
  acmeAccountKeyFile: string;
  siloHost: string;
  namesiloApiKeyFile: string;
}
