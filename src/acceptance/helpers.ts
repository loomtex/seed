// Acceptance test helpers — SSH, k8s client setup, S3 utilities.

import { execFile } from "node:child_process";
import * as k8s from "@kubernetes/client-node";
import { makeClients, type KubeClients } from "../shared/kube.js";
import { hostname } from "node:os";

// --- Types ---

export interface AcceptanceTest {
  name: string;
  category: string;
  run: (ctx: TestContext) => Promise<TestResult>;
}

export interface TestContext {
  nodes: string[];
  k8s: KubeClients;
  ssh: (host: string, cmd: string) => Promise<ExecResult>;
  s3: { bucket: string; endpoint: string };
}

export interface TestResult {
  pass: boolean;
  message: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

// --- SSH ---

const SSH_TIMEOUT_MS = 30_000;

export function ssh(host: string, cmd: string): Promise<ExecResult> {
  const localHostname = hostname();
  // If we're on the target node, run locally instead of SSH
  if (host === localHostname) {
    return execAsync("bash", ["-c", cmd]);
  }
  return new Promise((resolve) => {
    execFile(
      "ssh",
      ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, cmd],
      { timeout: SSH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err && "code" in err ? (err.code as number) : err ? 1 : 0;
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
      },
    );
  });
}

// --- k8s ---

export function k8sClients(): KubeClients {
  const kc = new k8s.KubeConfig();
  // Prefer default kubeconfig (file-based) over in-cluster — acceptance
  // tests run on nodes or workstations, not inside pods.
  try {
    kc.loadFromDefault();
  } catch {
    kc.loadFromCluster();
  }
  return makeClients(kc);
}

// --- S3 ---

/** List .narinfo keys in the S3 bucket via curl. Returns an array of keys. */
export async function s3ListNarinfos(
  bucket: string,
  endpoint: string,
  maxKeys = 100,
): Promise<string[]> {
  const url = `https://${endpoint}/${bucket}?list-type=2&max-keys=${maxKeys}`;
  const result = await execAsync("curl", ["-sf", url]);
  if (result.code !== 0) return [];
  // Parse XML keys — simple regex extraction (no dependency needed)
  const keys: string[] = [];
  const re = /<Key>([^<]+\.narinfo)<\/Key>/g;
  let m;
  while ((m = re.exec(result.stdout)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

/** Fetch a single narinfo from S3. */
export async function s3GetNarinfo(
  bucket: string,
  endpoint: string,
  key: string,
): Promise<string | null> {
  const url = `https://${endpoint}/${bucket}/${key}`;
  const result = await execAsync("curl", ["-sf", url]);
  return result.code === 0 ? result.stdout : null;
}

export function execAsync(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err && "code" in err ? (err.code as number) : err ? 1 : 0;
      resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), code });
    });
  });
}
