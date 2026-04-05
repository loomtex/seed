# SSHFP publishing — posts host key fingerprint to PowerDNS
#
# Runs once on boot after host keys are generated.
# Publishes Ed25519 key fingerprint as SSHFP record for silo.loom.farm.
{ config, pkgs, lib, hostKeyDir, ... }:

let
  publishSshfp = pkgs.writeShellScript "silo-publish-sshfp" ''
    set -euo pipefail

    API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})
    API="http://dns.s-gaydazldmnsg.svc.cluster.local:8081/api/v1/servers/localhost"

    # Read ed25519 host key
    HOST_KEY="${hostKeyDir}/ssh_host_ed25519_key.pub"
    if [ ! -f "$HOST_KEY" ]; then
      echo "silo-publish-sshfp: no ed25519 host key found" >&2
      exit 1
    fi

    # Compute SHA-256 fingerprint of the raw key bytes
    KEY_BLOB=$(${pkgs.gawk}/bin/awk '{print $2}' "$HOST_KEY")
    SHA256=$(echo "$KEY_BLOB" | ${pkgs.coreutils}/bin/base64 -d | ${pkgs.openssl}/bin/openssl dgst -sha256 -hex | ${pkgs.gawk}/bin/awk '{print $NF}')

    # SSHFP: algorithm 4 (Ed25519), type 2 (SHA-256)
    SSHFP_RECORD="4 2 $SHA256"

    # Wait for pdns API (up to 30s)
    for i in $(seq 1 30); do
      ${pkgs.curl}/bin/curl -sf -H "X-API-Key: $API_KEY" "$API" > /dev/null && break
      sleep 1
    done

    # Publish SSHFP record
    ${pkgs.curl}/bin/curl -sf -X PATCH \
      -H "X-API-Key: $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"rrsets\":[{\"name\":\"silo.loom.farm.\",\"type\":\"SSHFP\",\"ttl\":3600,\"changetype\":\"REPLACE\",\"records\":[{\"content\":\"$SSHFP_RECORD\",\"disabled\":false}]}]}" \
      "$API/zones/loom.farm."

    echo "silo-publish-sshfp: published SSHFP 4 2 $SHA256"
  '';

in {
  systemd.services.silo-publish-sshfp = {
    description = "Publish SSH host key fingerprint as SSHFP DNS record";
    wantedBy = [ "multi-user.target" ];
    after = [ "sshd-keygen.service" "network-online.target" ];
    wants = [ "sshd-keygen.service" "network-online.target" ];
    path = [ pkgs.curl pkgs.openssl pkgs.gawk pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = publishSshfp;
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };
}
