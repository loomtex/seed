import { execFileSync, execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { NodeConfig } from "./types.ts";
import {
  sshToAge,
  addNodeToSops,
  encryptSecrets,
  reencryptSecrets,
  updateLuksRecovery,
} from "./sops.ts";
import { createClevisJWE, generateLuksPassphrase } from "./clevis.ts";

interface SSHKeyPair {
  privateKey: string;
  publicKey: string;
}

interface ProvisionResult {
  luksPassphrase: string;
  agePublicKey: string;
}

// Generate an SSH key pair. Returns the key material as strings.
function generateSSHKeys(
  comment: string,
  type: "ed25519" | "rsa" = "ed25519"
): SSHKeyPair {
  const tmpDir = mkdtempSync(join(tmpdir(), "ssh-"));
  const keyPath = join(tmpDir, "key");

  const args = ["-t", type, "-C", comment, "-f", keyPath, "-N", ""];
  if (type === "rsa") {
    args.push("-b", "4096");
  }
  execFileSync("ssh-keygen", args, { stdio: "pipe" });

  const privateKey = execFileSync("cat", [keyPath], { encoding: "utf-8" });
  const publicKey = execFileSync("cat", [`${keyPath}.pub`], {
    encoding: "utf-8",
  });

  rmSync(tmpDir, { recursive: true });

  return { privateKey: privateKey.trim(), publicKey: publicKey.trim() };
}

// Wait for SSH to become available on a host.
// If sshProxy is set, tests connectivity through the proxy.
function waitForSSH(
  ip: string,
  { timeout = 600, port = 22, sshProxy, user = "root" }: { timeout?: number; port?: number; sshProxy?: string; user?: string } = {}
): void {
  const deadline = Date.now() + timeout * 1000;
  const baseOpts = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=5",
  ];

  const sshArgs = sshProxy
    ? [...baseOpts, sshProxy, `ssh ${baseOpts.join(" ")} -p ${port} ${user}@${ip} true`]
    : [...baseOpts, "-p", String(port), `${user}@${ip}`, "true"];

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", sshArgs, { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      // Retry after a short delay
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`SSH to ${ip}:${port} not available after ${timeout}s`);
}

// Wait for SSH to go down (indicates reboot in progress).
function waitForSSHDown(
  ip: string,
  { timeout = 120 }: { timeout?: number } = {}
): void {
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync(
        "ssh",
        [
          "-o",
          "StrictHostKeyChecking=no",
          "-o",
          "UserKnownHostsFile=/dev/null",
          "-o",
          "ConnectTimeout=3",
          `root@${ip}`,
          "true",
        ],
        { stdio: "pipe", timeout: 8_000 }
      );
      // Still up — wait and retry
      execFileSync("sleep", ["3"]);
    } catch {
      // SSH failed — host is going down
      return;
    }
  }
  console.warn(`SSH to ${ip} did not go down within ${timeout}s`);
}

// Prepare the extra-files directory for nixos-anywhere.
// Layout matches mynix impermanence configuration:
//   /persist/etc/ssh/ssh_host_{ed25519,rsa}_key{,.pub}
//   /persist/secrets/initrd/ssh_host_ed25519_key{,.pub}
//   /persist/secrets/clevis-cryptroot.jwe
//   /persist/seed/server-addr  (joining nodes only)
function prepareExtraFiles(args: {
  hostEd25519: SSHKeyPair;
  hostRsa: SSHKeyPair;
  initrdKey: SSHKeyPair;
  clevisJWE: string;
  serverAddr?: string; // k3s server URL for joining nodes
}): string {
  const dir = mkdtempSync(join(tmpdir(), "extra-files-"));

  // Host SSH keys → /persist/etc/ssh/
  const sshDir = join(dir, "persist", "etc", "ssh");
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key"), args.hostEd25519.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_ed25519_key.pub"), args.hostEd25519.publicKey + "\n", { mode: 0o644 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key"), args.hostRsa.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(sshDir, "ssh_host_rsa_key.pub"), args.hostRsa.publicKey + "\n", { mode: 0o644 });

  // Initrd SSH key → /persist/secrets/initrd/
  const initrdDir = join(dir, "persist", "secrets", "initrd");
  mkdirSync(initrdDir, { recursive: true });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key"), args.initrdKey.privateKey + "\n", { mode: 0o600 });
  writeFileSync(join(initrdDir, "ssh_host_ed25519_key.pub"), args.initrdKey.publicKey + "\n", { mode: 0o644 });

  // Clevis JWE → /persist/secrets/
  const secretsDir = join(dir, "persist", "secrets");
  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(join(secretsDir, "clevis-cryptroot.jwe"), args.clevisJWE + "\n", { mode: 0o600 });

  // Server addr for joining nodes → /persist/seed/server-addr
  if (args.serverAddr) {
    const seedDir = join(dir, "persist", "seed");
    mkdirSync(seedDir, { recursive: true });
    writeFileSync(join(seedDir, "server-addr"), args.serverAddr, { mode: 0o644 });
  }

  return dir;
}

// Verify node health after nixos-anywhere install + reboot.
// Uses current Unix user (not root) since nodes have PermitRootLogin=no.
function verifyNodeHealth(ip: string, label: string): void {
  const user = userInfo().username;
  const sshCmd = (cmd: string) =>
    execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        cmd,
      ],
      { encoding: "utf-8", timeout: 30_000 }
    ).trim();

  // Check hostname
  const hostname = sshCmd("hostname");
  if (hostname !== label) {
    console.warn(`Expected hostname ${label}, got ${hostname}`);
  }

  // Check LUKS is active
  const luks = sshCmd("sudo ls /dev/mapper/cryptroot 2>/dev/null && echo ok || echo missing");
  if (!luks.includes("ok")) {
    throw new Error(`LUKS device not active on ${label}`);
  }

  // Check SSH host key fingerprint
  const fingerprint = sshCmd(
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
  );
  console.log(`${label} SSH fingerprint: ${fingerprint}`);
}

// Attempt LUKS unlock via initrd SSH (port 2222).
// Used as fallback when first-boot auto-unlock fails.
function unlockLuksViaInitrd(ip: string, passphrase: string): void {
  const sshBase = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-p", "2222",
  ];

  console.log(`Attempting LUKS unlock via initrd SSH at ${ip}:2222`);

  // systemd-tty-ask-password-agent in --watch mode reads from stdin
  // We pipe the passphrase to it
  execSync(
    `echo -n ${shellQuote(passphrase)} | ssh ${sshBase.join(" ")} root@${ip} "systemd-tty-ask-password-agent"`,
    { stdio: "pipe", timeout: 30_000 }
  );
  console.log(`LUKS passphrase sent via initrd SSH`);
}

// Wait for k3s API server to be ready on a node.
function waitForK3s(ip: string, timeout = 300): void {
  const user = userInfo().username;
  const deadline = Date.now() + timeout * 1000;

  while (Date.now() < deadline) {
    try {
      execFileSync("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "sudo k3s kubectl get nodes",
      ], { stdio: "pipe", timeout: 15_000 });
      return;
    } catch {
      execFileSync("sleep", ["5"]);
    }
  }
  throw new Error(`k3s not ready on ${ip} after ${timeout}s`);
}

// Fetch k3s token from a running cluster node.
function fetchK3sToken(ip: string): string {
  const user = userInfo().username;
  const token = execFileSync(
    "ssh",
    [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      `${user}@${ip}`,
      "sudo cat /var/lib/rancher/k3s/server/token",
    ],
    { encoding: "utf-8", timeout: 15_000 }
  ).trim();
  if (!token.startsWith("K10")) {
    throw new Error(`Unexpected k3s token format from ${ip}: ${token.slice(0, 20)}...`);
  }
  return token;
}

// Generate a random k3s cluster token (for init node bootstrapping).
function generateK3sToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

// Trigger Vultr "reinstall" on a bare metal server.
// This re-PXE-boots the server from its startup script. Vultr BMs only PXE boot
// on initial creation or after a reinstall — a plain reboot won't re-PXE.
function reinstallBareMetal(apiKey: string, bmId: string): void {
  console.log(`Triggering Vultr reinstall for bare metal ${bmId}`);
  execFileSync("curl", [
    "-sf", "-X", "POST",
    `https://api.vultr.com/v2/bare-metals/${bmId}/reinstall`,
    "-H", `Authorization: Bearer ${apiKey}`,
    "-H", "Content-Type: application/json",
  ], { stdio: "pipe", timeout: 30_000 });
}

// Wait for SSH, with automatic Vultr reinstall fallback for BMs that failed PXE boot.
// First tries SSH for initialTimeout seconds. If that fails and we have Vultr API
// credentials, triggers a reinstall (re-PXE) and waits again for reinstallTimeout.
function waitForSSHWithReinstall(
  ip: string,
  config: NodeConfig,
  vultrApiKey: string | undefined,
  { initialTimeout = 300, reinstallTimeout = 600, sshProxy }: { initialTimeout?: number; reinstallTimeout?: number; sshProxy?: string } = {},
): void {
  try {
    waitForSSH(ip, { timeout: initialTimeout, sshProxy });
  } catch {
    if (config.vultrBmId && vultrApiKey) {
      console.log(`${config.name}: SSH timeout after ${initialTimeout}s — triggering Vultr reinstall (re-PXE boot)`);
      reinstallBareMetal(vultrApiKey, config.vultrBmId);
      waitForSSH(ip, { timeout: reinstallTimeout, sshProxy });
    } else {
      throw new Error(`${config.name}: SSH not available after ${initialTimeout}s and no reinstall credentials`);
    }
  }
}

// Full provisioning workflow for a single node.
// Runs synchronously.
export function provisionNode(
  ip: string,
  config: NodeConfig,
  vultrApiKey?: string,
): ProvisionResult {
  console.log(`Provisioning ${config.name} at ${ip}...`);

  // Check if node is already provisioned and healthy — skip if so.
  // This makes the provisioner idempotent (safe to re-run after failures).
  try {
    verifyNodeHealth(ip, config.name);
    console.log(`${config.name}: already provisioned and healthy, skipping`);
    const user = userInfo().username;
    const existingPubKey = execFileSync(
      "ssh",
      [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        "cat /etc/ssh/ssh_host_ed25519_key.pub",
      ],
      { encoding: "utf-8", timeout: 15_000 }
    ).trim();
    const agePublicKey = sshToAge(existingPubKey);
    return { luksPassphrase: "", agePublicKey };
  } catch {
    console.log(`${config.name}: not yet provisioned, proceeding`);
  }

  // 1. Generate SSH host keys
  console.log(`${config.name}: generating SSH host keys`);
  const hostEd25519 = generateSSHKeys(`root@${config.name}`, "ed25519");
  const hostRsa = generateSSHKeys(`root@${config.name}`, "rsa");
  const initrdKey = generateSSHKeys(`initrd@${config.name}`, "ed25519");

  // 2. Derive age public key from ed25519 host key
  const agePublicKey = sshToAge(hostEd25519.publicKey);
  console.log(`${config.name}: age key = ${agePublicKey}`);

  // 3. Update .sops.yaml with node's age key
  console.log(`${config.name}: updating sops configuration`);
  const sopsYamlPath = join(config.mynixDir, ".sops.yaml");
  addNodeToSops(sopsYamlPath, config.name, agePublicKey);

  // 4. Get or generate k3s token + create per-node secrets file
  console.log(`${config.name}: creating node secrets`);
  let k3sToken: string;
  if (config.clusterInit) {
    k3sToken = generateK3sToken();
    console.log(`${config.name}: generated new k3s cluster token`);
  } else if (config.initNodeIp) {
    k3sToken = fetchK3sToken(config.initNodeIp);
    console.log(`${config.name}: fetched k3s token from init node ${config.initNodeIp}`);
  } else {
    throw new Error(`${config.name}: joining node requires initNodeIp to fetch k3s token`);
  }
  encryptSecrets(config.mynixDir, `secrets/${config.name}.yaml`, {
    "seed/k3s-token": k3sToken,
  });

  // 5. Re-encrypt seed-system.yaml so the new node can decrypt shared secrets
  console.log(`${config.name}: re-encrypting seed-system.yaml`);
  reencryptSecrets(config.mynixDir, "secrets/seed-system.yaml");

  // 6. Generate LUKS passphrase + Clevis JWE
  console.log(`${config.name}: creating LUKS passphrase + Clevis JWE`);
  const luksPassphrase = generateLuksPassphrase();
  const clevisJWE = createClevisJWE(luksPassphrase, config.tangUrl, config.sshProxy);

  // 7. Store LUKS passphrase in sops-encrypted recovery file + commit all secrets
  console.log(`${config.name}: storing LUKS recovery passphrase`);
  updateLuksRecovery(config.mynixDir, config.name, luksPassphrase);
  execSync(
    `cd ${shellQuote(config.mynixDir)} && git add .sops.yaml secrets/ && git commit -m "infra: add secrets + sops config for ${config.name}" && git push`,
    { stdio: "pipe", timeout: 30_000 }
  );

  // 8. Prepare extra-files
  console.log(`${config.name}: preparing extra-files`);

  // Joining nodes: write server-addr so k3s knows which server to join.
  // Uses the init node's actual IP (not the reserved IP, which may not be
  // attached yet). Once the cluster is stable, the reserved IP can be
  // configured as the permanent endpoint.
  let serverAddr: string | undefined;
  if (!config.clusterInit && config.initNodeIp) {
    serverAddr = `https://${config.initNodeIp}:6443`;
  }

  const extraDir = prepareExtraFiles({
    hostEd25519,
    hostRsa,
    initrdKey,
    clevisJWE,
    serverAddr,
  });

  // Write LUKS passphrase to temp file for nixos-anywhere
  const passFile = join(extraDir, ".luks-pass");
  writeFileSync(passFile, luksPassphrase, { mode: 0o600 });

  // 9. Wait for iPXE instance SSH (with reinstall fallback for PXE failures)
  console.log(`${config.name}: waiting for iPXE instance SSH at ${ip}`);
  waitForSSHWithReinstall(ip, config, vultrApiKey, { sshProxy: config.sshProxy });

  // 10. Run nixos-anywhere
  console.log(`${config.name}: running nixos-anywhere`);
  execSync(
    [
      "nixos-anywhere",
      "--flake",
      config.flakeRef,
      "--build-on", "local",
      "--disk-encryption-keys",
      "/tmp/disk-password",
      passFile,
      "--extra-files",
      extraDir,
      "--phases",
      "disko,install,reboot",
      `root@${ip}`,
    ].join(" "),
    {
      stdio: "inherit",
      timeout: 1800_000, // 30 minutes
      env: {
        ...process.env,
        // tarball-ttl=0 forces nix to re-fetch the flake from GitHub,
        // ensuring the just-pushed secrets/sops changes are included in the build.
        NIX_CONFIG: "experimental-features = nix-command flakes\ntarball-ttl = 0",
      },
    }
  );

  // 11. Wait for reboot + verify (with initrd LUKS fallback)
  console.log(`${config.name}: waiting for reboot`);
  waitForSSHDown(ip, { timeout: 120 });
  console.log(`${config.name}: waiting for post-install SSH`);
  try {
    // First, try waiting for normal SSH (port 22) — if Clevis auto-unlock
    // worked, the system boots fully and SSH comes up directly.
    waitForSSH(ip, { timeout: 180, user: userInfo().username });
  } catch {
    // Normal SSH didn't come up — likely stuck at LUKS prompt in initrd.
    // Fall back to unlocking via initrd SSH (port 2222).
    console.log(`${config.name}: normal SSH timeout, trying initrd LUKS unlock`);
    try {
      waitForSSH(ip, { timeout: 120, port: 2222, user: "root" });
      unlockLuksViaInitrd(ip, luksPassphrase);
      console.log(`${config.name}: LUKS unlocked via initrd, waiting for full boot`);
    } catch (e) {
      console.warn(`${config.name}: initrd SSH also failed — may need manual LUKS unlock`);
    }
    waitForSSH(ip, { timeout: 300, user: userInfo().username });
  }

  console.log(`${config.name}: verifying health`);
  verifyNodeHealth(ip, config.name);

  // 12. For init node: wait for k3s API and create seed-cluster-config ConfigMap
  //     with reserved IPs so the controller can configure MetalLB.
  if (config.clusterInit && (config.reservedIpv4 || config.reservedIpv6)) {
    console.log(`${config.name}: waiting for k3s API`);
    waitForK3s(ip, 300);

    const user = userInfo().username;
    const sshCmd = (cmd: string) =>
      execFileSync("ssh", [
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        `${user}@${ip}`,
        cmd,
      ], { stdio: "pipe", timeout: 30_000 });

    const literals: string[] = [];
    if (config.reservedIpv4) literals.push(`--from-literal=SEED_IPV4_ADDRESS=${config.reservedIpv4}`);
    if (config.reservedIpv6) literals.push(`--from-literal=SEED_IPV6_BLOCK=${config.reservedIpv6}`);

    sshCmd(`sudo k3s kubectl create namespace seed-system --dry-run=client -o yaml | sudo k3s kubectl apply -f -`);
    sshCmd(`sudo k3s kubectl create configmap seed-cluster-config -n seed-system ${literals.join(" ")} --dry-run=client -o yaml | sudo k3s kubectl apply -f -`);

    // Restart controller if it started before ConfigMap existed
    try {
      sshCmd(`sudo k3s kubectl rollout restart deployment/seed-controller -n seed-system 2>/dev/null`);
    } catch {
      // Controller deployment may not exist yet — that's fine, it'll pick up the ConfigMap on first start
    }
    console.log(`${config.name}: seed-cluster-config ConfigMap created`);
  }

  // Cleanup
  rmSync(extraDir, { recursive: true });

  console.log(`${config.name}: provisioning complete`);

  return { luksPassphrase, agePublicKey };
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
