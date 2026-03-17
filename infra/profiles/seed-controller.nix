# Shared secrets for seed-system k8s workloads (controller, host-agent).
# Secrets are deployed as k8s Secrets via sops.templates + extraManifestPaths,
# not as hostPath mounts. This follows the same pattern as Ceph CSI.
{ config, ... }:
{
  sops.secrets."seed/controller/gh-webhook-secret" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };
  sops.secrets."seed/controller/pdns-api-key" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };
  sops.secrets."seed/controller/acme-account-key" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };

  sops.templates."seed-controller-secrets.json" = {
    content = builtins.toJSON {
      apiVersion = "v1";
      kind = "Secret";
      metadata = {
        name = "seed-controller-secrets";
        namespace = "seed-system";
      };
      stringData = {
        "gh-webhook-secret" = config.sops.placeholder."seed/controller/gh-webhook-secret";
        "pdns-api-key" = config.sops.placeholder."seed/controller/pdns-api-key";
      };
    };
  };
}
