// Pool manager HTTP server — manages a pool of CLH VMs for
// hardware-isolated execution (nix eval/build and instance shoots).
//
// Endpoints:
//   POST /exec  — execute a command in a pool VM (nix mounts)
//   POST /shoot — fork an instance's storage into a pool VM
//   GET /health — pool status (idle/busy/total)
//
// Env vars:
//   SEED_POOL_SIZE        — number of warm VM slots (default 2)
//   SEED_POOL_PORT        — HTTP API port (default 9877)
//   SEED_POOL_KERNEL      — path to guest kernel (vmlinux)
//   SEED_POOL_INITRAMFS   — path to guest initramfs (cpio.gz)
//   SEED_CLH_BINARY       — path to cloud-hypervisor binary
//   SEED_VIRTIOFSD_BINARY — path to virtiofsd binary

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdir } from "node:fs/promises";
import { log, loadKubeConfig, makeClients, type KubeClients } from "../shared/kube.js";
import { LABELS } from "../shared/labels.js";
import { Pool, type PoolConfig } from "./pool.js";
import type { ExecRequest, MountSpec } from "./vm.js";

/** Path to the host nix store. */
const NIX_STORE_PATH = "/nix/store";
/** Path to the host nix var directory (contains store DB + daemon socket). */
const NIX_VAR_DIR = "/nix/var/nix";
/** Path to the host nix cache directory (fetcher cache, tarball cache). */
const NIX_CACHE_DIR = "/root/.cache/nix";

/** Standard nix mounts for eval/build workloads. */
const NIX_MOUNTS: MountSpec[] = [
  { tag: "nixstore", hostPath: NIX_STORE_PATH, mountPoint: "/nix/store" },
  { tag: "nixvar", hostPath: NIX_VAR_DIR, mountPoint: "/nix/var/nix" },
  { tag: "nixcache", hostPath: NIX_CACHE_DIR, mountPoint: "/root/.cache/nix" },
];

/** k3s local-path storage base directory. */
const K3S_STORAGE_DIR = "/var/lib/rancher/k3s/storage";

/** Shoot request from an instance. */
interface ShootRequest {
  command: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Resolve the host path of a PVC by scanning k3s local-path storage.
 * k3s local-path names directories as: pvc-<uuid>_<namespace>_<pvcName>
 */
async function resolvePvcHostPath(
  namespace: string,
  pvcName: string,
): Promise<string | null> {
  try {
    const entries = await readdir(K3S_STORAGE_DIR);
    const suffix = `_${namespace}_${pvcName}`;
    const match = entries.find((e) => e.startsWith("pvc-") && e.endsWith(suffix));
    return match ? `${K3S_STORAGE_DIR}/${match}` : null;
  } catch {
    return null;
  }
}

/**
 * Handle a /shoot request: identify the calling pod by source IP,
 * resolve its PVC mounts, and execute the command in a pool VM with
 * the same storage attached.
 */
async function handleShoot(
  req: IncomingMessage,
  clients: KubeClients,
  pool: Pool,
): Promise<{ status: number; body: string }> {
  // Read request body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks).toString();

  let request: ShootRequest;
  try {
    request = JSON.parse(body) as ShootRequest;
  } catch {
    return { status: 400, body: JSON.stringify({ error: "invalid JSON" }) };
  }

  if (!request.command || !Array.isArray(request.command) || request.command.length === 0) {
    return { status: 400, body: JSON.stringify({ error: "command must be a non-empty array" }) };
  }

  // Identify caller by source IP
  const sourceIP = req.socket.remoteAddress;
  if (!sourceIP) {
    return { status: 400, body: JSON.stringify({ error: "cannot determine source IP" }) };
  }

  // Strip IPv6-mapped IPv4 prefix (::ffff:10.42.x.x → 10.42.x.x)
  const cleanIP = sourceIP.replace(/^::ffff:/, "");
  log(COMPONENT, `shoot from ${cleanIP}: ${request.command.join(" ")}`);

  // Look up pod by IP
  const podList = await clients.core.listPodForAllNamespaces({
    fieldSelector: `status.podIP=${cleanIP}`,
  });
  const pods = podList.items;
  if (!pods || pods.length === 0) {
    return { status: 403, body: JSON.stringify({ error: `no pod found with IP ${cleanIP}` }) };
  }
  const pod = pods[0];
  const namespace = pod.metadata?.namespace;
  const instance = pod.metadata?.labels?.[LABELS.INSTANCE];

  if (!namespace || !instance) {
    return { status: 403, body: JSON.stringify({ error: "pod is not a seed instance" }) };
  }

  log(COMPONENT, `shoot: identified as ${namespace}/${instance}`, instance);

  // Build mount specs: nix store (always, RO) + PVC mounts from pod spec
  const mounts: MountSpec[] = [
    { tag: "nixstore", hostPath: NIX_STORE_PATH, mountPoint: "/nix/store" },
  ];

  // Extract PVC claims and their mount paths from the pod spec
  const containers = pod.spec?.containers || [];
  const volumes = pod.spec?.volumes || [];

  // Build PVC name → volume name mapping
  const pvcVolumes = new Map<string, string>();
  for (const vol of volumes) {
    if (vol.persistentVolumeClaim?.claimName) {
      pvcVolumes.set(vol.name, vol.persistentVolumeClaim.claimName);
    }
  }

  // Find mount paths for PVC volumes
  let tagIdx = 0;
  for (const container of containers) {
    for (const vm of container.volumeMounts || []) {
      const pvcName = pvcVolumes.get(vm.name);
      if (!pvcName) continue;

      const hostPath = await resolvePvcHostPath(namespace, pvcName);
      if (!hostPath) {
        log(COMPONENT, `shoot: PVC ${pvcName} not found on local storage`, instance);
        continue;
      }

      const tag = `pvc${tagIdx++}`;
      mounts.push({
        tag,
        hostPath,
        mountPoint: vm.mountPath!,
      });
      log(COMPONENT, `shoot: mounting PVC ${pvcName} → ${vm.mountPath}`, instance);
    }
  }

  // Execute in pool VM
  const execRequest: ExecRequest = {
    command: request.command,
    env: request.env,
    timeout: request.timeout,
  };
  const result = await pool.exec(execRequest, mounts);

  return { status: 200, body: JSON.stringify(result) };
}

const COMPONENT = "pool-manager";

function loadConfig(): PoolConfig {
  const kernelPath = process.env["SEED_POOL_KERNEL"];
  if (!kernelPath) throw new Error("SEED_POOL_KERNEL must be set");

  const initramfsPath = process.env["SEED_POOL_INITRAMFS"];
  if (!initramfsPath) throw new Error("SEED_POOL_INITRAMFS must be set");

  const clhBinary = process.env["SEED_CLH_BINARY"] || "cloud-hypervisor";
  const virtiofsdBinary = process.env["SEED_VIRTIOFSD_BINARY"] || "virtiofsd";

  return {
    poolSize: parseInt(process.env["SEED_POOL_SIZE"] || "2", 10),
    kernelPath,
    initramfsPath,
    clhBinary,
    virtiofsdBinary,
    vcpus: 2,
    memory: "2G",
    workDir: "/run/seed-pool",
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env["SEED_POOL_PORT"] || "9877", 10);

  log(COMPONENT, `starting (poolSize=${config.poolSize}, port=${port})`);

  // Initialize k8s client (for /shoot pod lookup)
  const kc = loadKubeConfig();
  const clients = makeClients(kc);

  const pool = new Pool(config);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(COMPONENT, "shutting down");
    await pool.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => { shutdown(); });
  process.on("SIGINT", () => { shutdown(); });

  // Start pool initialization (async — server starts immediately, /exec
  // will wait until pool is ready)
  const poolReady = pool.start().catch((err) => {
    log(COMPONENT, `fatal: pool initialization failed: ${err}`);
    process.exit(1);
  });

  // HTTP server
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const status = pool.status();
        const body = JSON.stringify(status);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        });
        res.end(body);
        return;
      }

      if (req.method === "POST" && req.url === "/exec") {
        // Wait for pool to be ready if still initializing
        await poolReady;

        // Read request body
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const body = Buffer.concat(chunks).toString();

        let request: ExecRequest;
        try {
          request = JSON.parse(body) as ExecRequest;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON" }));
          return;
        }

        if (!request.command || !Array.isArray(request.command) || request.command.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "command must be a non-empty array" }));
          return;
        }

        log(COMPONENT, `exec: ${request.command.join(" ")}`);
        const result = await pool.exec(request, NIX_MOUNTS);

        const responseBody = JSON.stringify(result);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(responseBody)),
        });
        res.end(responseBody);
        return;
      }

      if (req.method === "POST" && req.url === "/shoot") {
        // Wait for pool to be ready if still initializing
        await poolReady;

        const result = await handleShoot(req, clients, pool);
        res.writeHead(result.status, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(result.body)),
        });
        res.end(result.body);
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(COMPONENT, `request error: ${msg}`);

      if (!res.headersSent) {
        const errorBody = JSON.stringify({ error: msg });
        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(errorBody)),
        });
        res.end(errorBody);
      }
    }
  });

  server.listen(port, "0.0.0.0", () => {
    log(COMPONENT, `listening on 0.0.0.0:${port}`);
  });
}

main().catch((err) => {
  log(COMPONENT, `fatal: ${err}`);
  process.exit(1);
});
