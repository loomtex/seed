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

export interface SeedMeta {
  name: string;
  system: string;
  size: string;
  resources: SeedResources;
  expose: Record<string, SeedExposeEntry>;
  storage: Record<string, SeedStorageEntry>;
  connect: Record<string, SeedConnectEntry>;
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
  pod: k8s.V1Pod;
  services: k8s.V1Service[];
  pvcs: k8s.V1PersistentVolumeClaim[];
  hostTask: SeedHostTask | null;
}

export interface DesiredState {
  generation: string;
  namespace: string;
  instances: Map<string, InstanceState>;
  routes: {
    ipv4: k8s.V1Service[];
    ipv6: k8s.V1Service[];
  };
}

// --- Builder Job result (stored in ConfigMap) ---

export interface BuildResult {
  imagePath: string;
  meta: SeedMeta;
}

// --- Controller configuration ---

export interface ControllerConfig {
  flakePath: string;
  namespace: string;
  interval: number;
  ipv4Address: string;
  ipv6Block: string;
  webhookSecretFile: string;
  builderImage: string;
  swtpmEnabled: boolean;
}
