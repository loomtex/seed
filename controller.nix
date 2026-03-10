# Seed controller — reconciles instance definitions into Kata pods
#
# Deploys as k8s-native components:
#   - seed-controller: Deployment pod (reconciliation engine + webhook)
#   - seed-host-agent: DaemonSet pod (privileged, manages swtpm on host)
#   - seed-builder: Jobs created by controller for nix build/eval
#
# The controller runs inside the cluster with proper RBAC, communicates
# via standard k8s primitives (CRDs, ConfigMaps, Jobs), and self-heals.
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.controller;

  # SeedHostTask CRD definition
  seedHostTaskCRD = pkgs.writeText "seed-hosttask-crd.yaml" (builtins.toJSON {
    apiVersion = "apiextensions.k8s.io/v1";
    kind = "CustomResourceDefinition";
    metadata.name = "seedhosttasks.seed.loom.farm";
    spec = {
      group = "seed.loom.farm";
      versions = [{
        name = "v1alpha1";
        served = true;
        storage = true;
        schema.openAPIV3Schema = {
          type = "object";
          properties = {
            spec = {
              type = "object";
              properties = {
                type = { type = "string"; };
                instance = { type = "string"; };
                namespace = { type = "string"; };
              };
              required = [ "type" "instance" "namespace" ];
            };
            status = {
              type = "object";
              properties = {
                ready = { type = "boolean"; };
                socketPath = { type = "string"; };
                message = { type = "string"; };
              };
            };
          };
        };
        subresources.status = {};
      }];
      scope = "Namespaced";
      names = {
        plural = "seedhosttasks";
        singular = "seedhosttask";
        kind = "SeedHostTask";
        shortNames = [ "sht" ];
      };
    };
  });

  # Namespace for seed system components
  seedSystemNS = "seed-system";

  # ServiceAccount for controller
  controllerSA = pkgs.writeText "seed-controller-sa.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "ServiceAccount";
    metadata = {
      name = "seed-controller";
      namespace = seedSystemNS;
    };
  });

  # ServiceAccount for builder Jobs
  builderSA = pkgs.writeText "seed-builder-sa.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "ServiceAccount";
    metadata = {
      name = "seed-builder";
      namespace = seedSystemNS;
    };
  });

  # ClusterRole for controller
  controllerRole = pkgs.writeText "seed-controller-role.yaml" (builtins.toJSON {
    apiVersion = "rbac.authorization.k8s.io/v1";
    kind = "ClusterRole";
    metadata.name = "seed-controller";
    rules = [
      {
        apiGroups = [ "" ];
        resources = [ "namespaces" "pods" "persistentvolumeclaims" "services" "configmaps" "endpoints" ];
        verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
      }
      {
        apiGroups = [ "apps" ];
        resources = [ "deployments" ];
        verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
      }
      {
        apiGroups = [ "batch" ];
        resources = [ "jobs" ];
        verbs = [ "get" "list" "watch" "create" "delete" ];
      }
      {
        apiGroups = [ "node.k8s.io" ];
        resources = [ "runtimeclasses" ];
        verbs = [ "get" "create" "update" "patch" ];
      }
      {
        apiGroups = [ "metallb.io" ];
        resources = [ "ipaddresspools" "l2advertisements" ];
        verbs = [ "get" "list" "create" "update" "patch" ];
      }
      {
        apiGroups = [ "seed.loom.farm" ];
        resources = [ "seedhosttasks" "seedhosttasks/status" ];
        verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ];
      }
    ];
  });

  # ClusterRoleBinding for controller
  controllerRoleBinding = pkgs.writeText "seed-controller-rolebinding.yaml" (builtins.toJSON {
    apiVersion = "rbac.authorization.k8s.io/v1";
    kind = "ClusterRoleBinding";
    metadata.name = "seed-controller";
    subjects = [{
      kind = "ServiceAccount";
      name = "seed-controller";
      namespace = seedSystemNS;
    }];
    roleRef = {
      apiGroup = "rbac.authorization.k8s.io";
      kind = "ClusterRole";
      name = "seed-controller";
    };
  });

  # ClusterRole for builder (needs configmap write in instance namespace)
  builderRole = pkgs.writeText "seed-builder-role.yaml" (builtins.toJSON {
    apiVersion = "rbac.authorization.k8s.io/v1";
    kind = "ClusterRole";
    metadata.name = "seed-builder";
    rules = [
      {
        apiGroups = [ "" ];
        resources = [ "configmaps" ];
        verbs = [ "get" "create" "update" "patch" ];
      }
    ];
  });

  builderRoleBinding = pkgs.writeText "seed-builder-rolebinding.yaml" (builtins.toJSON {
    apiVersion = "rbac.authorization.k8s.io/v1";
    kind = "ClusterRoleBinding";
    metadata.name = "seed-builder";
    subjects = [{
      kind = "ServiceAccount";
      name = "seed-builder";
      namespace = seedSystemNS;
    }];
    roleRef = {
      apiGroup = "rbac.authorization.k8s.io";
      kind = "ClusterRole";
      name = "seed-builder";
    };
  });

  # Controller Deployment
  controllerDeployment = pkgs.writeText "seed-controller-deployment.yaml" (builtins.toJSON {
    apiVersion = "apps/v1";
    kind = "Deployment";
    metadata = {
      name = "seed-controller";
      namespace = seedSystemNS;
      labels."app.kubernetes.io/name" = "seed-controller";
    };
    spec = {
      replicas = 1;
      selector.matchLabels."app.kubernetes.io/name" = "seed-controller";
      template = {
        metadata.labels."app.kubernetes.io/name" = "seed-controller";
        spec = {
          serviceAccountName = "seed-controller";
          # Pin to this node — controller needs hostPath secrets (sops-nix)
          nodeSelector."kubernetes.io/hostname" = config.networking.hostName;
          # Default runtime — controller doesn't need Kata
          containers = [{
            name = "controller";
            image = "nix:0${cfg.controllerImage}";
            command = [ "${pkgs.nodejs_22}/bin/node" "/app/controller.mjs" ];
            # Cluster-level config (reserved IPs, etc.) from ConfigMap.
            # Created by provisioner after cluster bootstrap. Optional so the
            # controller starts even before the ConfigMap exists.
            envFrom = [{
              configMapRef = {
                name = "seed-cluster-config";
                optional = true;
              };
            }];
            env = [
              { name = "SEED_FLAKE_PATHS"; value = builtins.concatStringsSep "," cfg.flakePaths; }
              { name = "SEED_WEBHOOK_PORT"; value = toString cfg.webhook.port; }
              { name = "SEED_SWTPM_ENABLED"; value = if cfg.swtpmEnabled then "1" else ""; }
              { name = "SEED_BUILDER_IMAGE"; value = cfg.builderImage; }
              # nix needs flakes + nix-command enabled, and daemon mode (store is read-only mount)
              { name = "NIX_CONFIG"; value = "experimental-features = nix-command flakes"; }
              { name = "NIX_REMOTE"; value = "daemon"; }
              # CA certs for HTTPS (nix fetching from GitHub)
              { name = "NIX_SSL_CERT_FILE"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              { name = "SSL_CERT_FILE"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              { name = "GIT_SSL_CAINFO"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              # PATH: nix + git + coreutils (for nix eval/build)
              { name = "PATH"; value = lib.makeBinPath [ pkgs.nix pkgs.git pkgs.coreutils pkgs.gnutar pkgs.gzip pkgs.xz ]; }
            ] ++ lib.optional (cfg.webhook.secretFile != "") {
              name = "SEED_WEBHOOK_SECRET_FILE"; value = cfg.webhook.secretFile;
            } ++ lib.optional cfg.poolManager.enable {
              name = "SEED_POOL_MANAGER_URL"; value = "http://seed-pool-manager.${seedSystemNS}.svc.cluster.local:${toString cfg.poolManager.port}";
            };
            ports = [{
              containerPort = cfg.webhook.port;
              name = "webhook";
              protocol = "TCP";
            }];
            volumeMounts = [
              { name = "nix-daemon"; mountPath = "/nix/var/nix/daemon-socket"; }
              { name = "nix-store"; mountPath = "/nix/store"; readOnly = true; }
            ] ++ lib.optional (cfg.webhook.secretFile != "") {
              name = "webhook-secret";
              mountPath = builtins.dirOf cfg.webhook.secretFile;
              readOnly = true;
            };
          }];
          volumes = [
            { name = "nix-daemon"; hostPath.path = "/nix/var/nix/daemon-socket"; }
            { name = "nix-store"; hostPath.path = "/nix/store"; }
          ] ++ lib.optional (cfg.webhook.secretFile != "") {
            name = "webhook-secret";
            hostPath = {
              path = builtins.dirOf cfg.webhook.secretFile;
              type = "Directory";
            };
          };
        };
      };
    };
  });

  # Controller webhook Service (for Caddy reverse proxy)
  controllerService = pkgs.writeText "seed-controller-service.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "Service";
    metadata = {
      name = "seed-controller";
      namespace = seedSystemNS;
    };
    spec = {
      selector."app.kubernetes.io/name" = "seed-controller";
      ports = [{
        port = cfg.webhook.port;
        targetPort = cfg.webhook.port;
        protocol = "TCP";
        name = "webhook";
      }];
    };
  });

  # Host agent DaemonSet (privileged — manages swtpm on host)
  hostAgentDaemonSet = pkgs.writeText "seed-host-agent-daemonset.yaml" (builtins.toJSON {
    apiVersion = "apps/v1";
    kind = "DaemonSet";
    metadata = {
      name = "seed-host-agent";
      namespace = seedSystemNS;
      labels."app.kubernetes.io/name" = "seed-host-agent";
    };
    spec = {
      selector.matchLabels."app.kubernetes.io/name" = "seed-host-agent";
      template = {
        metadata.labels."app.kubernetes.io/name" = "seed-host-agent";
        spec = {
          serviceAccountName = "seed-controller";
          # Default runtime — host agent needs host access, not Kata
          hostPID = false;
          hostNetwork = true;
          containers = [{
            name = "host-agent";
            image = "nix:0${cfg.hostAgentImage}";
            command = [ "${pkgs.nodejs_22}/bin/node" "/app/host-agent.mjs" ];
            securityContext.privileged = true;
            volumeMounts = [
              { name = "tpm-state"; mountPath = "/var/lib/seed-controller/tpm"; }
              { name = "swtpm-sockets"; mountPath = "/run/swtpm"; }
            ];
          }];
          volumes = [
            { name = "tpm-state"; hostPath = { path = "/var/lib/seed-controller/tpm"; type = "DirectoryOrCreate"; }; }
            { name = "swtpm-sockets"; hostPath = { path = "/run/swtpm"; type = "DirectoryOrCreate"; }; }
          ];
        };
      };
    };
  });

  # Pool manager DaemonSet (privileged — manages CLH VMs on host)
  poolManagerDaemonSet = pkgs.writeText "seed-pool-manager-daemonset.yaml" (builtins.toJSON {
    apiVersion = "apps/v1";
    kind = "DaemonSet";
    metadata = {
      name = "seed-pool-manager";
      namespace = seedSystemNS;
      labels."app.kubernetes.io/name" = "seed-pool-manager";
    };
    spec = {
      selector.matchLabels."app.kubernetes.io/name" = "seed-pool-manager";
      template = {
        metadata.labels."app.kubernetes.io/name" = "seed-pool-manager";
        spec = {
          serviceAccountName = "seed-controller";
          hostPID = false;
          hostNetwork = true;
          containers = [{
            name = "pool-manager";
            image = "nix:0${cfg.poolManager.image}";
            command = [ "${pkgs.nodejs_22}/bin/node" "/app/pool-manager.mjs" ];
            securityContext.privileged = true;
            env = [
              { name = "SEED_POOL_SIZE"; value = toString cfg.poolManager.poolSize; }
              { name = "SEED_POOL_PORT"; value = toString cfg.poolManager.port; }
              { name = "NIX_REMOTE"; value = "daemon"; }
              { name = "NIX_CONFIG"; value = "experimental-features = nix-command flakes"; }
              { name = "NIX_SSL_CERT_FILE"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              { name = "SSL_CERT_FILE"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              { name = "GIT_SSL_CAINFO"; value = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"; }
              { name = "PATH"; value = lib.makeBinPath [ pkgs.nix pkgs.git pkgs.coreutils pkgs.gnutar pkgs.gzip pkgs.xz pkgs.socat ]; }
            ];
            ports = [{
              containerPort = cfg.poolManager.port;
              name = "api";
              protocol = "TCP";
            }];
            volumeMounts = [
              { name = "nix-store"; mountPath = "/nix/store"; readOnly = true; }
              { name = "nix-var"; mountPath = "/nix/var/nix"; }
              { name = "nix-cache"; mountPath = "/root/.cache/nix"; }
              { name = "dev-kvm"; mountPath = "/dev/kvm"; }
              { name = "dev-vhost-vsock"; mountPath = "/dev/vhost-vsock"; }
              { name = "pool-state"; mountPath = "/run/seed-pool"; }
              { name = "k3s-storage"; mountPath = "/var/lib/rancher/k3s/storage"; }
            ];
          }];
          volumes = [
            { name = "nix-store"; hostPath.path = "/nix/store"; }
            { name = "nix-var"; hostPath = { path = "/nix/var/nix"; type = "Directory"; }; }
            { name = "nix-cache"; hostPath = { path = "/root/.cache/nix"; type = "DirectoryOrCreate"; }; }
            { name = "dev-kvm"; hostPath = { path = "/dev/kvm"; type = "CharDevice"; }; }
            { name = "dev-vhost-vsock"; hostPath = { path = "/dev/vhost-vsock"; type = "CharDevice"; }; }
            { name = "pool-state"; hostPath = { path = "/var/lib/seed-pool"; type = "DirectoryOrCreate"; }; }
            { name = "k3s-storage"; hostPath = { path = "/var/lib/rancher/k3s/storage"; type = "DirectoryOrCreate"; }; }
          ];
        };
      };
    };
  });

  # Pool manager Service — internalTrafficPolicy: Local ensures requests
  # from instance pods always reach the pool manager on the same node.
  # This is critical because shoots mount node-local PVC storage via virtiofs.
  poolManagerService = pkgs.writeText "seed-pool-manager-service.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "Service";
    metadata = {
      name = "seed-pool-manager";
      namespace = seedSystemNS;
    };
    spec = {
      selector."app.kubernetes.io/name" = "seed-pool-manager";
      internalTrafficPolicy = "Local";
      ports = [{
        port = cfg.poolManager.port;
        targetPort = cfg.poolManager.port;
        protocol = "TCP";
        name = "api";
      }];
    };
  });

  # Namespace manifest
  seedSystemNamespace = pkgs.writeText "seed-system-namespace.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "Namespace";
    metadata.name = seedSystemNS;
  });
in {
  options.seed.controller = {
    enable = lib.mkEnableOption "Seed instance controller";

    flakePaths = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "Flake paths containing seeds.* outputs.";
    };

    ipv4Address = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Reserved IPv4 address for public LoadBalancer services.";
    };

    ipv6Block = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Reserved IPv6 /64 block for public LoadBalancer services (e.g. 2001:db8::/64).";
    };

    controllerImage = lib.mkOption {
      type = lib.types.str;
      description = "Nix store path to the controller OCI image.";
    };

    hostAgentImage = lib.mkOption {
      type = lib.types.str;
      description = "Nix store path to the host agent OCI image.";
    };

    builderImage = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Nix image ref for builder Job pods. Empty = controller runs nix directly.";
    };

    swtpmEnabled = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "Enable vTPM (swtpm) for all instances via SeedHostTask CRDs.";
    };

    webhook = {
      enable = lib.mkEnableOption "Seed webhook for cache-busting reconciliation";

      port = lib.mkOption {
        type = lib.types.port;
        default = 9876;
        description = "Port for the webhook HTTP listener.";
      };

      secretFile = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          Path to file containing the HMAC-SHA256 secret for GitHub webhook verification.
          Empty = no authentication (accept all requests).
        '';
      };
    };

    poolManager = {
      enable = lib.mkEnableOption "Pool manager for hardware-isolated nix eval/build";

      poolSize = lib.mkOption {
        type = lib.types.int;
        default = 2;
        description = "Number of warm VM slots per node.";
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 9877;
        description = "Port for the pool manager HTTP API.";
      };

      image = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Nix store path to the pool manager OCI image.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    # Deploy k8s manifests via k3s auto-deploy
    systemd.services.k3s.serviceConfig.ExecStartPre = lib.mkAfter [
      "+${pkgs.writeShellScript "seed-controller-manifests" ''
        dir="/var/lib/rancher/k3s/server/manifests"
        mkdir -p "$dir"
        ln -sf ${seedSystemNamespace} "$dir/seed-system-namespace.yaml"
        ln -sf ${seedHostTaskCRD} "$dir/seed-hosttask-crd.yaml"
        ln -sf ${controllerSA} "$dir/seed-controller-sa.yaml"
        ln -sf ${builderSA} "$dir/seed-builder-sa.yaml"
        ln -sf ${controllerRole} "$dir/seed-controller-role.yaml"
        ln -sf ${controllerRoleBinding} "$dir/seed-controller-rolebinding.yaml"
        ln -sf ${builderRole} "$dir/seed-builder-role.yaml"
        ln -sf ${builderRoleBinding} "$dir/seed-builder-rolebinding.yaml"
        ln -sf ${controllerDeployment} "$dir/seed-controller-deployment.yaml"
        ln -sf ${controllerService} "$dir/seed-controller-service.yaml"
        ${lib.optionalString cfg.swtpmEnabled ''
          ln -sf ${hostAgentDaemonSet} "$dir/seed-host-agent-daemonset.yaml"
        ''}
        ${lib.optionalString cfg.poolManager.enable ''
          ln -sf ${poolManagerDaemonSet} "$dir/seed-pool-manager-daemonset.yaml"
          ln -sf ${poolManagerService} "$dir/seed-pool-manager-service.yaml"
        ''}
      ''}"
    ];
  };
}
