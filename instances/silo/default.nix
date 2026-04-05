# Seed silo instance — git server with cgit web interface
#
# Identity = SSH key. No accounts, no database.
# First push auto-creates a bare repo. ACLs via .authorized_keys in each repo.
# Host key fingerprint published as SSHFP DNS record to PowerDNS.
# cgit provides read-only web browsing with syntax highlighting and markdown rendering.
{ config, pkgs, lib, ... }:

let
  reposDir = "/seed/storage/repos";
  # Dotfile so cgit scan-path skips it (hidden dirs are ignored)
  hostKeyDir = "${reposDir}/.ssh-host-keys";
in {
  imports = [
    ./shell.nix
    ./hooks.nix
    ./cgit.nix
    ./archive.nix
    ./sshfp.nix
  ];

  # Pass shared paths to submodules
  _module.args = { inherit reposDir hostKeyDir; };

  seed.expose.ssh.enable = true;
  seed.expose.https.enable = true;
  seed.expose.http.enable = true;
  seed.dns.names = [ "silo.loom.farm" ];
  seed.storage.repos = { size = "10Gi"; user = "git"; group = "git"; };
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };
  seed.shoot.enable = true;

  # sops-nix secrets
  sops.defaultSopsFile = ../../secrets/silo.yaml;
  sops.secrets.pdns-api-key = {};
  sops.secrets.silo-webhook-secret = { owner = "git"; };

  users.groups.git = {};

  systemd.tmpfiles.rules = [
    "d ${hostKeyDir} 0700 root root -"
    # Remove lost+found — ext4 creates it but cgit scan-path errors on it
    "R ${reposDir}/lost+found -"
  ];

  # Migrate ssh-host-keys to dotfile path (one-time, idempotent)
  systemd.services.silo-migrate-hostkeys = {
    description = "Migrate SSH host keys to hidden directory";
    wantedBy = [ "multi-user.target" ];
    before = [ "sshd.service" "sshd-keygen.service" ];
    unitConfig.ConditionPathIsDirectory = "${reposDir}/ssh-host-keys";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "migrate-hostkeys" ''
        # Move old visible dir to new hidden dir
        if [ -d "${reposDir}/ssh-host-keys" ] && [ ! -d "${hostKeyDir}" ]; then
          mv "${reposDir}/ssh-host-keys" "${hostKeyDir}"
        elif [ -d "${reposDir}/ssh-host-keys" ] && [ -d "${hostKeyDir}" ]; then
          # Both exist — copy any missing keys, remove old dir
          cp -n "${reposDir}/ssh-host-keys/"* "${hostKeyDir}/" 2>/dev/null || true
          rm -rf "${reposDir}/ssh-host-keys"
        fi
      '';
    };
  };

  # Extra sshd settings on top of what seed.sshAuth provides
  services.openssh = {
    ports = [ 22 ];
    # Persist host keys in PVC
    hostKeys = [
      { path = "${hostKeyDir}/ssh_host_ed25519_key"; type = "ed25519"; }
      { path = "${hostKeyDir}/ssh_host_rsa_key"; type = "rsa"; bits = 4096; }
    ];
  };

  # Force host key generation on boot (startWhenNeeded=true defers it to first connection)
  systemd.services.sshd-keygen.wantedBy = [ "multi-user.target" ];

  networking.firewall.allowedTCPPorts = [ 22 80 443 ];

  environment.systemPackages = [ pkgs.git pkgs.openssl ];
}
