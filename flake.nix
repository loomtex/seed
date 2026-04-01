{
  description = "The Vercel for Nix derivations — VM-isolated compute on k3s + Kata Containers";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    nix-snapshotter = {
      url = "github:joshperry/nix-snapshotter/k3s-1.34-support";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nix-snapshotter, sops-nix, ... }:
  let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
      overlays = [
        nix-snapshotter.overlays.default
        self.overlays.default
      ];
    };

    mkInstance = import ./lib/mkInstance.nix { inherit nixpkgs self; };
    mkImage = import ./lib/mkImage.nix { inherit pkgs; };
    mkSeed = import ./lib/mkSeed.nix { inherit mkInstance mkImage; };
  in {
    # Overlay: patch kata-runtime for nix-snapshotter + CLH paths + TPM kernel
    overlays.default = final: prev: {
      # Custom guest kernel: kata's minimal config + TPM 2.0 CRB support
      # Upstream kata-images ships without CONFIG_TCG_TPM — we rebuild
      # the guest vmlinux from the same config with TPM options enabled.
      kata-guest-kernel-tpm = final.stdenv.mkDerivation {
        pname = "kata-guest-kernel-tpm";
        version = "6.12.22";

        src = final.fetchurl {
          url = "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-6.12.22.tar.xz";
          hash = "sha256-q0iACrSZhaeNIxiuisXyj9PhI+oXNX7yFJgQWlMzczY=";
        };

        nativeBuildInputs = with final; [
          flex bison bc perl openssl elfutils
        ];

        configurePhase = ''
          runHook preConfigure

          # Start from kata's minimal guest kernel config
          cp ${prev.kata-runtime.passthru.kata-images}/share/kata-containers/config-6.12.22-151 .config
          chmod +w .config

          # Enable TPM 2.0 support (CRB interface for CLH/swtpm)
          sed -i 's/^# CONFIG_TCG_TPM is not set$/CONFIG_TCG_TPM=y/' .config
          sed -i 's/^# CONFIG_SECURITYFS is not set$/CONFIG_SECURITYFS=y/' .config
          echo 'CONFIG_TCG_CRB=y' >> .config
          echo 'CONFIG_TCG_TPM2_HMAC=y' >> .config

          # Resolve new dependencies
          make olddefconfig

          runHook postConfigure
        '';

        buildPhase = ''
          runHook preBuild
          make -j$NIX_BUILD_CORES vmlinux
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp vmlinux $out/vmlinux
          runHook postInstall
        '';

        # Don't try to strip the kernel binary
        dontStrip = true;
      };

      # CSI sidecars for Ceph RBD (and future CSI drivers)
      csi-provisioner = final.buildGoModule rec {
        pname = "csi-provisioner";
        version = "5.1.0";
        src = final.fetchFromGitHub {
          owner = "kubernetes-csi"; repo = "external-provisioner";
          rev = "v${version}"; hash = "sha256-NmKfRgnVj4auBZp3SRX5yb3r4clMN7gNenPaaz3ZyTY=";
        };
        vendorHash = null;
        subPackages = [ "cmd/csi-provisioner" ];
        ldflags = [ "-s" "-w" "-X main.version=v${version}" ];
      };

      csi-attacher = final.buildGoModule rec {
        pname = "csi-attacher";
        version = "4.7.0";
        src = final.fetchFromGitHub {
          owner = "kubernetes-csi"; repo = "external-attacher";
          rev = "v${version}"; hash = "sha256-TqfBLZQjLqNCg3awhrvedK8Ye4MODP9EFHyYQ7jM+qI=";
        };
        vendorHash = null;
        subPackages = [ "cmd/csi-attacher" ];
        ldflags = [ "-s" "-w" "-X main.version=v${version}" ];
      };

      csi-resizer = final.buildGoModule rec {
        pname = "csi-resizer";
        version = "1.12.0";
        src = final.fetchFromGitHub {
          owner = "kubernetes-csi"; repo = "external-resizer";
          rev = "v${version}"; hash = "sha256-4YN4XzLjjhULfkxmgMpSVYK4H/snJDSnCdub6Vn7BFw=";
        };
        vendorHash = null;
        subPackages = [ "cmd/csi-resizer" ];
        ldflags = [ "-s" "-w" "-X main.version=v${version}" ];
      };

      csi-node-driver-registrar = final.buildGoModule rec {
        pname = "csi-node-driver-registrar";
        version = "2.12.0";
        src = final.fetchFromGitHub {
          owner = "kubernetes-csi"; repo = "node-driver-registrar";
          rev = "v${version}"; hash = "sha256-5uWpaIbD/bmAwLdwkU8GHxrSjD3bw0tibofTqumC+dA=";
        };
        vendorHash = null;
        subPackages = [ "cmd/csi-node-driver-registrar" ];
        ldflags = [ "-s" "-w" "-X main.version=v${version}" ];
      };

      # Split-path NVRAM backend for multi-host TPM: routes permall to
      # shared storage (CephFS) and volatile state to local tmpfs.
      # IMPORTANT: This is a separate package, NOT an override of pkgs.swtpm.
      # Overriding swtpm globally would cascade: tpm2-tss (test dep on swtpm)
      # → systemd → zfs → ceph → everything, rebuilding the entire closure.
      swtpm-seed = prev.swtpm.overrideAttrs (old: {
        pname = "swtpm-seed";
        patches = (old.patches or []) ++ [
          ./patches/swtpm-seed-backend.patch
        ];
      });

      kata-runtime = prev.kata-runtime.overrideAttrs (old: {
        # Patch kata shim to support multi-mount rootfs from snapshotters
        # like nix-snapshotter that return overlay + bind mounts:
        # 1. Populate rootFs metadata from first mount even with multiple mounts
        # 2. Copy Mount.Target field for subdirectory bind mount resolution
        # 3. Use recursive bind (MS_BIND|MS_REC) so sub-mounts propagate
        #    through virtiofs into the guest VM
        patches = (old.patches or []) ++ [
          ./patches/kata-multi-mount-rootfs.patch
          ./patches/kata-tpm-socket.patch
        ];

        # Fix CLH paths and use TPM-enabled guest kernel
        postInstall = (old.postInstall or "") + ''
          sed -i \
            -e 's!path = ".*cloud-hypervisor"!path = "${final.cloud-hypervisor}/bin/cloud-hypervisor"!' \
            -e 's!valid_hypervisor_paths = \[".*cloud-hypervisor"\]!valid_hypervisor_paths = ["${final.cloud-hypervisor}/bin/cloud-hypervisor"]!' \
            -e 's!kernel = ".*vmlinux.container"!kernel = "${final.kata-guest-kernel-tpm}/vmlinux"!' \
            "$out/share/defaults/kata-containers/configuration-clh.toml"
        '';
      });

      # lego ACME client: remove HTTPS-only enforcement (added in v4.25.2)
      # so instances can talk to the controller's HTTP ACME endpoint over
      # cluster-internal networking. Traffic is within the k8s trust boundary.
      lego = prev.lego.overrideAttrs (old: {
        postPatch = (old.postPatch or "") + ''
          substituteInPlace acme/api/internal/sender/sender.go \
            --replace-fail 'client.Transport = newHTTPSOnly(client)' ""
        '';
      });
    };

    # NixOS modules
    nixosModules = {
      # Node-level: k3s + nix-snapshotter + Kata/CLH
      default = {
        imports = [
          nix-snapshotter.nixosModules.default
          ./module.nix
        ];
        nixpkgs.overlays = [
          nix-snapshotter.overlays.default
          self.overlays.default
        ];
      };

      # Import alongside impermanence to auto-persist /var/lib/rancher
      persistence = ./persistence.nix;

      # Instance-level: seed.size, seed.expose, seed.storage, seed.connect
      instance = ./instance.nix;

      # Stripped NixOS profile for Kata VM guests
      instance-base = ./instance-base.nix;

      # sops-nix for instance secrets decryption via TPM
      sops = sops-nix.nixosModules.sops;

      # SSH any-key identity auth (used by seed-shell and silo)
      ssh-auth = ./ssh-auth.nix;

      # Controller: reconciles instance definitions into Kata pods
      controller = ./controller.nix;
    };

    # Helpers: build Seed instances and images
    lib.mkSeed = mkSeed;
    lib.mkInstance = mkInstance;
    lib.mkImage = mkImage;

    # Combinable k8s components: pkgs -> args -> { image, imageRef, container }
    lib.mkK8sComponent = pkgs: import ./lib/mkK8sComponent.nix { inherit pkgs; };
    # Ceph RBD CSI composition: { pkgs, mkK8sComponent } -> config -> manifests
    lib.mkCephCsiRbd = import ./lib/mkCephCsiRbd.nix;
    # cert-manager: { pkgs, mkK8sComponent } -> config -> { manifests, platformCA, images }
    lib.mkCertManager = import ./lib/mkCertManager.nix;

    # Re-export nix-snapshotter home modules for rootless k3s consumers
    homeModules = nix-snapshotter.homeModules;

    # Test VM: boots k3s + Kata + controller, requires KVM on host
    nixosConfigurations.vm = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        self.nixosModules.default
        self.nixosModules.controller
        ./vm.nix
      ];
    };

    # Minimal NixOS netboot image for iPXE-based bare metal provisioning.
    # Boots SSH + DHCP, then nixos-anywhere handles disko + install.
    nixosConfigurations.installer = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [ ./infra/installer/installer.nix ];
    };

    apps.${system}.vm = {
      type = "app";
      program = "${self.nixosConfigurations.vm.config.system.build.vm}/bin/run-nixos-vm";
    };

    # Dogfooding: seed's own instances
    seeds = {
      web = mkSeed { name = "web"; module = ./instances/web.nix; };
      dns = mkSeed { name = "dns"; module = ./instances/dns.nix; };
      silo = mkSeed { name = "silo"; module = ./instances/silo.nix; };
      shell = mkSeed { name = "shell"; module = ./instances/shell.nix; };
      gateway = mkSeed { name = "gateway"; module = ./instances/gateway.nix; };
      social = mkSeed { name = "social"; module = ./instances/social.nix; };
      keycloak = mkSeed { name = "keycloak"; module = ./instances/keycloak.nix; };
    };

    # Controller + host agent TypeScript packages
    packages.${system} = let
      # Build TypeScript controller and host agent
      seedController = pkgs.buildNpmPackage {
        pname = "seed-controller";
        version = "0.1.0";
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = path: type:
            let base = builtins.baseNameOf path; in
            (type == "directory" && builtins.elem base [ "src" ]) ||
            (type == "directory" && builtins.elem base [ "shared" "controller" "host-agent" "pool-manager" "acceptance" ]) ||
            builtins.match ".*\\.ts$" path != null ||
            builtins.match ".*\\.mjs$" path != null ||
            builtins.elem base [ "package.json" "package-lock.json" "tsconfig.json" "build.mjs" ];
        };
        npmDepsHash = "sha256-4YKyDpdPk57FpfeR6ilPVpS5JS/n2//Ph1dW8BksRL0=";
        buildPhase = ''
          runHook preBuild
          node build.mjs
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/app
          cp dist/controller.mjs $out/app/
          cp dist/host-agent.mjs $out/app/
          cp dist/pool-manager.mjs $out/app/
          cp dist/acceptance.mjs $out/app/
          # Copy k8s client (external in esbuild)
          cp -r node_modules $out/app/
          runHook postInstall
        '';
      };
    in {
      # Bundled TypeScript
      controller = seedController;

      # Acceptance test runner (not an OCI image — runs from CLI)
      acceptance = pkgs.writeShellScriptBin "seed-acceptance" ''
        export PATH="${pkgs.lib.makeBinPath [ pkgs.openssh pkgs.curl ]}:$PATH"
        # Auto-detect k3s kubeconfig if no KUBECONFIG is set
        if [ -z "$KUBECONFIG" ] && [ -f /etc/rancher/k3s/k3s.yaml ]; then
          export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
        fi
        exec ${pkgs.nodejs_22}/bin/node ${seedController}/app/acceptance.mjs "$@"
      '';

      # OCI images for k8s deployment
      controllerImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-controller";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "controller-rootfs" {} ''
          mkdir -p $out/{app,tmp,nix/store}
          cp ${seedController}/app/controller.mjs $out/app/
          cp -r ${seedController}/app/node_modules $out/app/
        '';
        config.entrypoint = [ "${pkgs.nodejs_22}/bin/node" "/app/controller.mjs" ];
      };

      hostAgentImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-host-agent";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "host-agent-rootfs" {} ''
          mkdir -p $out/{app,tmp,nix/store,usr/bin}
          cp ${seedController}/app/host-agent.mjs $out/app/
          cp -r ${seedController}/app/node_modules $out/app/
          ln -s ${pkgs.swtpm-seed}/bin/swtpm $out/usr/bin/swtpm
          ln -s ${pkgs.iptables}/bin/iptables $out/usr/bin/iptables
          ln -s ${pkgs.iptables}/bin/ip6tables $out/usr/bin/ip6tables
        '';
        config.entrypoint = [ "${pkgs.nodejs_22}/bin/node" "/app/host-agent.mjs" ];
      };

      builderImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-builder";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "builder-rootfs" {} ''
          mkdir -p $out/{tmp,nix/store,bin}
          ln -s ${pkgs.bash}/bin/bash $out/bin/sh
        '';
        config.entrypoint = [ "${pkgs.bash}/bin/bash" ];
        config.env = [
          "PATH=${pkgs.lib.makeBinPath [ pkgs.bash pkgs.coreutils pkgs.nix pkgs.kubectl pkgs.git ]}"
        ];
      };

      # swtpm image (existing, for TPM pods)
      swtpmImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-swtpm";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "swtpm-rootfs" {} ''
          mkdir -p $out/{tmp,nix/store,run}
        '';
        config.entrypoint = [ "${pkgs.swtpm-seed}/bin/swtpm" ];
      };

      # Pool VM initramfs: cpio+gzip initramfs for snapshot-based nix eval/build VMs
      poolVmInitramfs = pkgs.runCommand "pool-vm-initramfs" {
        nativeBuildInputs = [ pkgs.cpio ];
      } ''
        # Create initramfs layout
        mkdir -p rootfs/{bin,proc,sys,dev,tmp,run,nix/store,nix/var/nix/daemon-socket}

        # Full static busybox for pre-virtiofs phase (needs mount, sleep, etc.)
        cp ${pkgs.pkgsStatic.busybox}/bin/busybox rootfs/bin/busybox
        for cmd in sh mount umount mkdir sleep cat echo ls ln chmod cp; do
          ln -s busybox rootfs/bin/$cmd
        done

        # Init script (two-phase: template boot + post-restore)
        #
        # Phase 1 (template boot): mount basics, then sleep forever.
        #   The pool manager pauses the VM via CLH API after boot.
        #
        # Phase 2 (after snapshot restore + virtiofs hotplug + resume):
        #   VM wakes from sleep. virtiofs has been hotplugged but not yet
        #   mounted. Mount it, set up PATH from nix store, listen on vsock
        #   for a command, execute it, write result.
        cat > rootfs/init << 'INITEOF'
#!/bin/sh
# Phase 1: basic mounts (runs on template boot)
mount -t proc proc /proc
mount -t sysfs sys /sys
mount -t devtmpfs dev /dev
mount -t tmpfs tmpfs /tmp
mount -t tmpfs tmpfs /run
mkdir -p /run/nix

echo ready > /tmp/.pool-ready

# Phase 2 (after snapshot restore + virtiofs hotplug + resume):
# Mount nixstore (always present), then serve commands.
# Additional mounts (nixvar, nixcache, PVC storage, etc.) are
# specified per-request in the JSON command and mounted by the agent.

# Wait for nixstore virtiofs (hotplugged after restore)
mkdir -p /tmp/nix-lower /tmp/store-upper /tmp/store-work
while true; do
  mount -t virtiofs nixstore /tmp/nix-lower 2>/dev/null && break
  sleep 0.1
done

# Overlay: writable nix store (tmpfs upper for lock files + new paths,
# virtiofs lower for existing store paths). Required because nix creates
# .lock files in /nix/store/ during flake input resolution.
mount -t overlay overlay \
  -o lowerdir=/tmp/nix-lower,upperdir=/tmp/store-upper,workdir=/tmp/store-work \
  /nix/store

# Find tools in nix store
for d in /nix/store/*-socat-*/bin; do
  [ -x "$d/socat" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-nix-2.*/bin; do
  [ -x "$d/nix" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-git-2.*/bin; do
  [ -x "$d/git" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-coreutils-*/bin; do
  [ -x "$d/env" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-gnutar-*/bin; do
  [ -x "$d/tar" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-gzip-*/bin; do
  [ -x "$d/gzip" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-xz-*/bin; do
  [ -x "$d/xz" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-jq-*/bin; do
  [ -x "$d/jq" ] && export PATH="$d:$PATH" && break
done
for d in /nix/store/*-bash-*/bin; do
  [ -x "$d/bash" ] && export PATH="$d:$PATH" && break
done

export HOME=/tmp
export USER=root

# Find CA certs
for d in /nix/store/*-nss-cacert*/etc/ssl/certs; do
  if [ -f "$d/ca-bundle.crt" ]; then
    export NIX_SSL_CERT_FILE="$d/ca-bundle.crt"
    export SSL_CERT_FILE="$d/ca-bundle.crt"
    export GIT_SSL_CAINFO="$d/ca-bundle.crt"
    break
  fi
done

# Command agent: listen on vsock port 6001 for one command.
socat VSOCK-LISTEN:6001,reuseaddr EXEC:'/bin/sh /run/cmd-agent.sh' &

# Write the command agent script
cat > /run/cmd-agent.sh << 'AGENT'
#!/bin/sh
read -r request_json

# Mount additional virtiofs tags from request (nixvar, nixcache, PVC storage, etc.)
echo "$request_json" | jq -r '.mounts // {} | to_entries[] | "\(.key) \(.value)"' | \
while read -r tag mountpoint; do
  [ -z "$tag" ] && continue
  mkdir -p "$mountpoint"
  mount -t virtiofs "$tag" "$mountpoint" 2>/dev/null || true
done

# If nixvar was mounted (nix eval/build workloads), set up nix state
if [ -f /nix/var/nix/db/db.sqlite ]; then
  mkdir -p /tmp/nix-state/db
  cp /nix/var/nix/db/db.sqlite /tmp/nix-state/db/
  export NIX_STATE_DIR=/tmp/nix-state
  export NIX_REMOTE=""
  export NIX_CONFIG="experimental-features = nix-command flakes"
fi

# Parse command as properly shell-quoted array
cmd=$(echo "$request_json" | jq -r '.command | map(@sh) | join(" ")')
timeout_ms=$(echo "$request_json" | jq -r '.timeout // 120000')
timeout_s=$((timeout_ms / 1000))

# Set env vars from request
eval $(echo "$request_json" | jq -r '.env // {} | to_entries[] | "export \(.key)=\(.value|@sh)"' 2>/dev/null)

# Execute command, capture output
stdout_file=$(mktemp)
stderr_file=$(mktemp)
set +e
eval timeout "$timeout_s" $cmd > "$stdout_file" 2> "$stderr_file"
exit_code=$?
set -e

stdout=$(cat "$stdout_file")
stderr=$(cat "$stderr_file")

# Write JSON response
jq -nc --argjson exitCode "$exit_code" \
  --arg stdout "$stdout" \
  --arg stderr "$stderr" \
  '{exitCode: $exitCode, stdout: $stdout, stderr: $stderr}'
AGENT

# Wait for the socat command agent to finish
wait

# Halt — VM will be destroyed by pool manager
poweroff -f 2>/dev/null || true
INITEOF
        chmod +x rootfs/init

        # Create cpio archive
        cd rootfs
        find . | cpio -o -H newc | gzip > $out
      '';

      # Netboot artifacts for iPXE-based bare metal provisioning
      netboot = let
        installerBuild = self.nixosConfigurations.installer.config.system.build;
      in pkgs.symlinkJoin {
        name = "seed-netboot";
        paths = [
          installerBuild.netbootRamdisk
          installerBuild.kernel
          installerBuild.netbootIpxeScript
        ];
      };

      # Pool manager: maintains warm CLH VM pool for sandboxed nix eval/build
      poolManagerImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-pool-manager";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "pool-manager-rootfs" {} ''
          mkdir -p $out/{app,tmp,nix/store,run/seed-pool}
          cp ${seedController}/app/pool-manager.mjs $out/app/
          cp -r ${seedController}/app/node_modules $out/app/

          # Include VM runtime deps in the image closure so nix-snapshotter
          # realizes them on every node (not just the controller node).
          mkdir -p $out/app/deps
          ln -s ${pkgs.cloud-hypervisor} $out/app/deps/cloud-hypervisor
          ln -s ${pkgs.virtiofsd} $out/app/deps/virtiofsd
          ln -s ${pkgs.kata-guest-kernel-tpm} $out/app/deps/kata-guest-kernel
          ln -s ${self.packages.${system}.poolVmInitramfs} $out/app/deps/initramfs
        '';
        config.entrypoint = [ "${pkgs.nodejs_22}/bin/node" "/app/pool-manager.mjs" ];
      };
    };

    # Platform services — domain registration, etc.
    combine = {
      domains = {
        "loom.farm" = {
          register = true;
          default = true;
        };
      };
    };

    # Platform config — routing, networking, etc.
    seed = {
      ipv4 = {
        enable = true;
        routes = {
          dns = { port = 53; protocol = "dns"; instance = "gateway"; };
          http = { port = 80; protocol = "tcp"; instance = "gateway"; };
          https = { port = 443; protocol = "tcp"; instance = "gateway"; };
          silo-ssh = { port = 22; protocol = "tcp"; instance = "gateway"; };
        };
      };

      ipv6 = {
        enable = true;
        block = "2001:19f0:5400:20a7::/64";
        routes = {
          dns = { host = "1"; port = 53; protocol = "dns"; instance = "dns"; };
          dns2 = { host = "2"; port = 53; protocol = "dns"; instance = "dns"; };
          web-http = { host = "7"; port = 80; protocol = "tcp"; instance = "web"; };
          web-https = { host = "7"; port = 443; protocol = "tcp"; instance = "web"; };
          silo-https = { host = "8"; port = 443; protocol = "tcp"; instance = "silo"; };
          silo-ssh = { host = "8"; port = 22; protocol = "tcp"; instance = "silo"; };
          http = { host = "3"; port = 80; protocol = "tcp"; instance = "gateway"; };
          https = { host = "3"; port = 443; protocol = "tcp"; instance = "gateway"; };
          shell-ssh = { host = "5"; port = 22; protocol = "tcp"; instance = "shell"; };
          social-https = { host = "9"; port = 443; protocol = "tcp"; instance = "social"; };
        };
      };
    };

    # Automated tests (run with: nix flake check)
    checks.${system} = {
      # Tests metadata eval + image build (no KVM needed)
      image = import ./tests/image.nix { inherit self pkgs nixpkgs; };
      # Tests shell instance eval + image build
      shell = import ./tests/shell.nix { inherit self pkgs nixpkgs; };
      # Tests Vultr metadata API jq parsing (canned payloads, no network)
      metadata = import ./tests/metadata.nix { inherit pkgs; };
    };

    templates = {
      default = {
        path = ./templates/default;
        description = "Seed compute node — k3s + nix-snapshotter + Kata/CLH";
      };

      instance = {
        path = ./templates/instance;
        description = "Seed instance — NixOS workload running in a Kata VM";
      };

      instance-caddy = {
        path = ./templates/instance-caddy;
        description = "Seed instance — Caddy reverse proxy with automatic TLS";
      };

      instance-api = {
        path = ./templates/instance-api;
        description = "Seed instance — API server with encrypted secrets";
      };

      multi = {
        path = ./templates/multi;
        description = "Seed multi-instance — web frontend + API backend";
      };
    };

    devShells.${system}.tui = pkgs.mkShell {
      buildInputs = with pkgs; [ go gopls ];
    };
  };
}
