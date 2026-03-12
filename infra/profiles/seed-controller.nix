# Shared secrets for seed-system k8s workloads (controller, host-agent).
{ config, ... }:
{
  sops.secrets."seed/controller/gh-webhook-secret" = {
    sopsFile = ../secrets/seed-system.yaml;
  };
}
