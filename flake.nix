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

      # Controller: reconciles instance definitions into Kata pods
      controller = ./controller.nix;
    };

    # Helpers: build Seed instances and images
    lib.mkSeed = mkSeed;
    lib.mkInstance = mkInstance;
    lib.mkImage = mkImage;

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

    apps.${system}.vm = {
      type = "app";
      program = "${self.nixosConfigurations.vm.config.system.build.vm}/bin/run-nixos-vm";
    };

    # Dogfooding: seed's own instances
    seeds = {
      web = mkSeed { name = "web"; module = ./instances/web.nix; };
      dns = mkSeed { name = "dns"; module = ./instances/dns.nix; };
      silo = mkSeed { name = "silo"; module = ./instances/silo.nix; };
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
            (type == "directory" && builtins.elem base [ "shared" "controller" "host-agent" "pool-manager" ]) ||
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
          # Copy k8s client (external in esbuild)
          cp -r node_modules $out/app/
          runHook postInstall
        '';
      };
    in {
      # Bundled TypeScript
      controller = seedController;

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
          ln -s ${pkgs.swtpm}/bin/swtpm $out/usr/bin/swtpm
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
        config.entrypoint = [ "${pkgs.swtpm}/bin/swtpm" ];
      };

      # Pool VM initramfs: cpio+gzip initramfs for snapshot-based nix eval/build VMs
      poolVmInitramfs = pkgs.runCommand "pool-vm-initramfs" {
        nativeBuildInputs = [ pkgs.cpio ];
      } ''
        # Create initramfs layout
        mkdir -p rootfs/{bin,proc,sys,dev,tmp,run,nix/store,nix/var/nix/daemon-socket}

        # Full static busybox for pre-virtiofs phase (needs mount, sleep, etc.)
        cp ${pkgs.pkgsStatic.busybox}/bin/busybox rootfs/bin/busybox
        for cmd in sh mount umount mkdir sleep cat echo ls ln chmod; do
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

# Write "ready" marker so pool manager can detect boot completion
echo ready > /tmp/.pool-ready

# Sleep forever — pool manager will pause this VM via CLH API,
# snapshot it, then restore + resume later. After resume, execution
# continues right here at the sleep, which exits because the process
# receives no signal — it just keeps sleeping. The virtiofs hotplug
# happens while we're sleeping, so we loop checking for it.

# Wait for virtiofs to become available (hotplugged after restore)
while true; do
  mount -t virtiofs nixstore /nix/store 2>/dev/null && break
  sleep 0.1
done

# Mount nix-daemon socket directory via virtiofs
mount -t virtiofs nixdaemon /nix/var/nix/daemon-socket 2>/dev/null

# Now we have /nix/store — find tools
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

export NIX_REMOTE=daemon
export NIX_CONFIG="experimental-features = nix-command flakes"

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
# socat accepts one connection, reads a JSON line, we parse and exec it.
socat VSOCK-LISTEN:6001,reuseaddr EXEC:'/bin/sh /run/cmd-agent.sh' &

# Write the command agent script
cat > /run/cmd-agent.sh << 'AGENT'
#!/bin/sh
read -r request_json

# Parse command as array
cmd=$(echo "$request_json" | jq -r '.command | join(" ")')
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

      # Pool manager: maintains warm CLH VM pool for sandboxed nix eval/build
      poolManagerImage = pkgs.nix-snapshotter.buildImage {
        name = "seed-pool-manager";
        resolvedByNix = true;
        copyToRoot = pkgs.runCommand "pool-manager-rootfs" {} ''
          mkdir -p $out/{app,tmp,nix/store,run/seed-pool}
          cp ${seedController}/app/pool-manager.mjs $out/app/
          cp -r ${seedController}/app/node_modules $out/app/
        '';
        config.entrypoint = [ "${pkgs.nodejs_22}/bin/node" "/app/pool-manager.mjs" ];
      };
    };

    # Platform config — routing, networking, etc.
    seed = {
      ipv4 = {
        enable = true;
        routes = {
          dns = { port = 53; protocol = "dns"; instance = "dns"; };
          http = { port = 80; protocol = "tcp"; instance = "web"; };
          https = { port = 443; protocol = "tcp"; instance = "web"; };
        };
      };

      ipv6 = {
        enable = true;
        block = "2001:19f0:6402:7eb::/64";
        routes = {
          dns = { host = "1"; port = 53; protocol = "dns"; instance = "dns"; };
          dns2 = { host = "2"; port = 53; protocol = "dns"; instance = "dns"; };
          http = { host = "3"; port = 80; protocol = "tcp"; instance = "web"; };
          https = { host = "3"; port = 443; protocol = "tcp"; instance = "web"; };
          ssh = { host = "3"; port = 22; protocol = "tcp"; instance = "web"; };
        };
      };
    };

    # Automated tests (run with: nix flake check)
    checks.${system} = {
      # Tests metadata eval + image build (no KVM needed)
      image = import ./tests/image.nix { inherit self pkgs nixpkgs; };
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
    };
  };
}
