// CLH (Cloud Hypervisor) VM process management and API client.
//
// Manages CLH processes and virtiofsd for nix store / daemon sharing.
// Provides pause/resume/snapshot/restore/add-fs via CLH's HTTP API.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, access, constants } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import { log, waitFor, sleep } from "../shared/kube.js";

const COMPONENT = "pool-manager";

/** CID counter — monotonically increasing, unique per host. */
let nextCid = 100;

/** Configuration for a CLH VM. */
export interface VmConfig {
  kernelPath: string;
  initramfsPath: string;
  clhBinary: string;
  virtiofsdBinary: string;
  vcpus: number;
  memory: string; // e.g. "2G"
  workDir: string; // directory for sockets and state
}

/** Result of executing a command in a VM. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Request sent to the guest command agent via vsock. */
export interface ExecRequest {
  command: string[];
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Make an HTTP request to CLH's unix socket API.
 * CLH exposes its API on a unix socket at <workDir>/clh-api.sock.
 */
function clhRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const encoded = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {};
    if (encoded) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(encoded).toString();
    }

    const opts: http.RequestOptions = {
      socketPath,
      method,
      path,
      // CLH uses micro-http (from Firecracker) which doesn't support
      // chunked transfer encoding or HTTP/1.1 keep-alive.
      agent: false,
      headers,
    };

    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk as Buffer));
      res.on("end", () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on("error", reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

/** Managed child process with cleanup. */
interface ManagedProcess {
  process: ChildProcess;
  label: string;
}

/**
 * VmInstance manages the lifecycle of a single CLH VM:
 * - CLH process
 * - virtiofsd instances (nix store + nix-daemon socket sharing)
 */
export class VmInstance {
  private cid: number;
  private processes: ManagedProcess[] = [];
  private clhApiSocket: string;
  private vsockSocket: string;
  private destroyed = false;

  constructor(
    private config: VmConfig,
    private slotId: string,
  ) {
    this.cid = nextCid++;
    this.clhApiSocket = `${config.workDir}/${slotId}/clh-api.sock`;
    this.vsockSocket = `${config.workDir}/${slotId}/vsock.sock`;
  }

  get apiSocket(): string {
    return this.clhApiSocket;
  }

  get vsock(): string {
    return this.vsockSocket;
  }

  /**
   * Boot a template VM (no virtiofs, no vsock). Used once to create the
   * golden snapshot. Guest init mounts proc/sys/dev and then sleeps.
   * vsock is hotplugged per-slot after restore (snapshot can't contain
   * vsock because the socket path is baked in and must differ per slot).
   */
  async bootTemplate(): Promise<void> {
    const slotDir = `${this.config.workDir}/${this.slotId}`;
    await mkdir(slotDir, { recursive: true });

    // Clean stale sockets
    await this.cleanSockets();

    // Start CLH with kernel + initramfs only — NO --fs, NO --vsock.
    // vsock is hotplugged per-slot after restore because the socket path
    // is embedded in the snapshot and must be unique per concurrent VM.
    this.spawnProcess(this.config.clhBinary, [
      "--kernel", this.config.kernelPath,
      "--initramfs", this.config.initramfsPath,
      "--cpus", `boot=${this.config.vcpus}`,
      "--memory", `size=${this.config.memory},shared=on`,
      "--console", "null",
      "--serial", "tty",
      "--api-socket", this.clhApiSocket,
    ], "clh-template");

    // Wait for CLH API to be ready
    const apiReady = await waitFor(
      () => this.isApiReady(),
      200,
      15_000,
    );
    if (!apiReady) {
      throw new Error("CLH API not ready after 15s");
    }

    // Wait for guest init to complete basic mounts.
    // The guest mounts proc/sys/dev/tmpfs then enters a sleep loop.
    // This takes <500ms but we give it 3s to be safe.
    await waitFor(
      () => this.isVmRunning(),
      200,
      5_000,
    );
    // Extra delay for init script to finish mounting
    await sleep(2000);

    log(COMPONENT, `template VM booted (cid=${this.cid})`, this.slotId);
  }

  /**
   * Pause the VM via CLH API.
   */
  async pause(): Promise<void> {
    const resp = await clhRequest(this.clhApiSocket, "PUT", "/api/v1/vm.pause");
    if (resp.status !== 204 && resp.status !== 200) {
      throw new Error(`pause failed: ${resp.status} ${resp.body}`);
    }

    // Wait for VM to reach Paused state (CLH processes pause asynchronously)
    const paused = await waitFor(
      () => this.isVmInState("Paused"),
      100,
      10_000,
    );
    if (!paused) {
      throw new Error("VM did not reach Paused state after 10s");
    }
    log(COMPONENT, "VM paused", this.slotId);
  }

  /**
   * Snapshot the VM to a directory.
   */
  async snapshot(destDir: string): Promise<void> {
    await mkdir(destDir, { recursive: true });
    const resp = await clhRequest(this.clhApiSocket, "PUT", "/api/v1/vm.snapshot", {
      destination_url: `file://${destDir}`,
    });
    if (resp.status !== 204 && resp.status !== 200) {
      throw new Error(`snapshot failed: ${resp.status} ${resp.body}`);
    }
    log(COMPONENT, `VM snapshot saved to ${destDir}`, this.slotId);
  }

  /**
   * Restore a VM from a snapshot directory.
   * Starts a new CLH process with --restore.
   */
  async restoreFromSnapshot(snapshotDir: string): Promise<void> {
    const slotDir = `${this.config.workDir}/${this.slotId}`;
    await mkdir(slotDir, { recursive: true });
    await this.cleanSockets();

    this.spawnProcess(this.config.clhBinary, [
      "--api-socket", this.clhApiSocket,
      "--restore", `source_url=file://${snapshotDir}`,
    ], "clh-restore");

    // Wait for CLH API
    const apiReady = await waitFor(
      () => this.isApiReady(),
      200,
      15_000,
    );
    if (!apiReady) {
      throw new Error("CLH API not ready after restore (15s)");
    }

    log(COMPONENT, `VM restored from snapshot (cid=${this.cid})`, this.slotId);
  }

  /**
   * Start virtiofsd for sharing /nix/store (read-only).
   * Must be called before hotplugging the virtiofs device.
   */
  async startVirtiofsd(tag: string, sharedDir: string): Promise<string> {
    const slotDir = `${this.config.workDir}/${this.slotId}`;
    const virtiofsdSocket = `${slotDir}/virtiofsd-${tag}.sock`;

    // Clean stale socket
    try { await rm(virtiofsdSocket, { force: true }); } catch {}

    this.spawnProcess(this.config.virtiofsdBinary, [
      `--socket-path=${virtiofsdSocket}`,
      `--shared-dir=${sharedDir}`,
      "--cache=auto",
      "--sandbox=none",
    ], `virtiofsd-${tag}`);

    // Wait for socket
    const ready = await waitFor(
      async () => {
        try {
          await access(virtiofsdSocket, constants.F_OK);
          return true;
        } catch { return false; }
      },
      200,
      10_000,
    );
    if (!ready) {
      throw new Error(`virtiofsd socket not ready after 10s: ${virtiofsdSocket}`);
    }

    log(COMPONENT, `virtiofsd started (tag=${tag}, dir=${sharedDir})`, this.slotId);
    return virtiofsdSocket;
  }

  /**
   * Hotplug a virtiofs device into the running VM.
   */
  async addFs(tag: string, virtiofsdSocket: string): Promise<void> {
    const resp = await clhRequest(this.clhApiSocket, "PUT", "/api/v1/vm.add-fs", {
      tag,
      socket: virtiofsdSocket,
      num_queues: 1,
      queue_size: 1024,
    });
    if (resp.status !== 204 && resp.status !== 200) {
      throw new Error(`add-fs failed: ${resp.status} ${resp.body}`);
    }
    log(COMPONENT, `virtiofs hotplugged (tag=${tag})`, this.slotId);
  }

  /**
   * Hotplug a vsock device into the running/paused VM.
   * Must be called after restore — vsock is not part of the template snapshot.
   */
  async addVsock(): Promise<void> {
    const resp = await clhRequest(this.clhApiSocket, "PUT", "/api/v1/vm.add-vsock", {
      cid: this.cid,
      socket: this.vsockSocket,
    });
    if (resp.status !== 204 && resp.status !== 200) {
      throw new Error(`add-vsock failed: ${resp.status} ${resp.body}`);
    }
    log(COMPONENT, `vsock hotplugged (cid=${this.cid})`, this.slotId);
  }

  /**
   * Resume a paused VM.
   */
  async resume(): Promise<void> {
    const resp = await clhRequest(this.clhApiSocket, "PUT", "/api/v1/vm.resume");
    if (resp.status !== 204 && resp.status !== 200) {
      throw new Error(`resume failed: ${resp.status} ${resp.body}`);
    }
    log(COMPONENT, "VM resumed", this.slotId);
  }

  /**
   * Execute a command in the guest via vsock command channel (port 6001).
   * Sends a JSON request, reads a JSON response.
   */
  async exec(request: ExecRequest): Promise<ExecResult> {
    // The guest listens on vsock port 6001.
    // CLH exposes this as <vsock.sock>_6001 on host.
    const commandSocket = `${this.vsockSocket}_6001`;

    // Wait for the command socket to be available
    const socketReady = await waitFor(
      async () => {
        try {
          await access(commandSocket, constants.F_OK);
          return true;
        } catch { return false; }
      },
      200,
      10_000,
    );
    if (!socketReady) {
      throw new Error(`vsock command socket not ready: ${commandSocket}`);
    }

    return new Promise<ExecResult>((resolve, reject) => {
      const timeout = request.timeout ?? 120_000;
      const conn = net.createConnection({ path: commandSocket });
      let data = "";

      const timer = setTimeout(() => {
        conn.destroy();
        reject(new Error(`exec timed out after ${timeout}ms`));
      }, timeout + 5_000); // Extra 5s for VM-side timeout to fire first

      conn.on("connect", () => {
        conn.write(JSON.stringify(request) + "\n");
      });

      conn.on("data", (chunk) => {
        data += chunk.toString();
        // Look for complete JSON line
        const newlineIdx = data.indexOf("\n");
        if (newlineIdx !== -1) {
          clearTimeout(timer);
          try {
            const result = JSON.parse(data.slice(0, newlineIdx)) as ExecResult;
            conn.destroy();
            resolve(result);
          } catch (err) {
            conn.destroy();
            reject(new Error(`invalid JSON from guest: ${data.slice(0, newlineIdx)}`));
          }
        }
      });

      conn.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`vsock connection error: ${err.message}`));
      });

      conn.on("close", () => {
        clearTimeout(timer);
        // If we got data but no newline, try to parse it
        if (data.trim()) {
          try {
            resolve(JSON.parse(data.trim()) as ExecResult);
          } catch {
            reject(new Error(`incomplete response from guest: ${data}`));
          }
        }
      });
    });
  }

  /**
   * Destroy the VM and all associated processes.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const { process: proc, label } of this.processes) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // Already dead
      }
    }
    this.processes = [];

    log(COMPONENT, "VM destroyed", this.slotId);
  }

  /** Check if the CLH API socket is responding. */
  private async isApiReady(): Promise<boolean> {
    try {
      const resp = await clhRequest(this.clhApiSocket, "GET", "/api/v1/vmm.ping");
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /** Check if the VM is in a specific state via CLH API. */
  private async isVmInState(state: string): Promise<boolean> {
    try {
      const resp = await clhRequest(this.clhApiSocket, "GET", "/api/v1/vm.info");
      if (resp.status === 200) {
        const info = JSON.parse(resp.body);
        return info.state === state;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** Check if the VM is in Running state via CLH API. */
  private async isVmRunning(): Promise<boolean> {
    return this.isVmInState("Running");
  }

  /** Clean stale socket files. */
  private async cleanSockets(): Promise<void> {
    try { await rm(this.clhApiSocket, { force: true }); } catch {}
    try { await rm(this.vsockSocket, { force: true }); } catch {}
    // Clean vsock port socket (command channel)
    try { await rm(`${this.vsockSocket}_6001`, { force: true }); } catch {}
  }

  /** Spawn a child process and track it for cleanup. */
  private spawnProcess(command: string, args: string[], label: string): ChildProcess {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log(COMPONENT, `${label} stderr: ${msg}`, this.slotId);
    });

    child.on("error", (err) => {
      log(COMPONENT, `${label} error: ${err.message}`, this.slotId);
    });

    child.on("exit", (code, signal) => {
      if (!this.destroyed) {
        log(COMPONENT, `${label} exited (code=${code} signal=${signal})`, this.slotId);
      }
    });

    this.processes.push({ process: child, label });
    return child;
  }
}
