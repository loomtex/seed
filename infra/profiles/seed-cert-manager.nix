# cert-manager — X.509 certificate lifecycle management for the cluster.
#
# Deploys cert-manager via Helm-rendered manifests + a self-signed platform
# CA (seed-ca ClusterIssuer). Instances use seed-ca for mTLS certificates
# with TPM-backed key material.
#
# Requires specialArgs: seedFlake
{ config, lib, pkgs, seedFlake, ... }:

let
  mkK8sComponent = seedFlake.lib.mkK8sComponent pkgs;
  mkCertManager = seedFlake.lib.mkCertManager { inherit pkgs mkK8sComponent; };

  certManager = mkCertManager {
    # Defaults are fine: namespace=cert-manager, installCRDs=true
  };
in {
  seed.k8s.services.cert-manager = {
    manifests = certManager.manifests;
    extraManifestPaths = [
      "${certManager.platformCA}"
    ];
  };
}
