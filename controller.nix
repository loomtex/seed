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
          # Default runtime — controller doesn't need Kata
          containers = [{
            name = "controller";
            image = "nix:0${cfg.controllerImage}";
            command = [ "${pkgs.nodejs_22}/bin/node" "/app/controller.mjs" ];
            env = [
              { name = "SEED_FLAKE_PATH"; value = cfg.flakePath; }
              { name = "SEED_INTERVAL"; value = toString cfg.interval; }
              { name = "SEED_WEBHOOK_PORT"; value = toString cfg.webhook.port; }
              { name = "SEED_SWTPM_ENABLED"; value = if cfg.swtpmEnabled then "1" else ""; }
              { name = "SEED_BUILDER_IMAGE"; value = cfg.builderImage; }
            ] ++ lib.optional (cfg.namespace != "") {
              name = "SEED_NAMESPACE"; value = cfg.namespace;
            } ++ lib.optional (cfg.ipv4Address != "") {
              name = "SEED_IPV4_ADDRESS"; value = cfg.ipv4Address;
            } ++ lib.optional (cfg.ipv6Block != "") {
              name = "SEED_IPV6_BLOCK"; value = cfg.ipv6Block;
            } ++ lib.optional (cfg.webhook.secretFile != "") {
              name = "SEED_WEBHOOK_SECRET_FILE"; value = cfg.webhook.secretFile;
            };
            ports = [{
              containerPort = cfg.webhook.port;
              name = "webhook";
              protocol = "TCP";
            }];
            volumeMounts = [
              { name = "nix-daemon"; mountPath = "/nix/var/nix/daemon-socket"; }
              { name = "nix-store"; mountPath = "/nix/store"; readOnly = true; }
            ];
          }];
          volumes = [
            { name = "nix-daemon"; hostPath.path = "/nix/var/nix/daemon-socket"; }
            { name = "nix-store"; hostPath.path = "/nix/store"; }
          ];
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

  # Namespace manifest
  seedSystemNamespace = pkgs.writeText "seed-system-namespace.yaml" (builtins.toJSON {
    apiVersion = "v1";
    kind = "Namespace";
    metadata.name = seedSystemNS;
  });
in {
  options.seed.controller = {
    enable = lib.mkEnableOption "Seed instance controller";

    flakePath = lib.mkOption {
      type = lib.types.str;
      description = "Path to the flake containing seeds.* outputs.";
    };

    interval = lib.mkOption {
      type = lib.types.int;
      default = 30;
      description = "Reconciliation interval in seconds.";
    };

    namespace = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        Kubernetes namespace for seed resources.
        Empty (default) = auto-derive from flake URI. Set to override for dev/testing.
      '';
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
      ''}"
    ];
  };
}
