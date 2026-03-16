# mkCephCsiRbd — Ceph RBD CSI driver composition from combinable components.
#
# Pure function: cluster config → k8s manifests + NixOS host requirements.
# All 5 container images are built via mkK8sComponent (nix-snapshotter).
#
# The k8s Secret containing the Ceph auth key is returned separately as
# `secretManifestJSON` — a JSON string suitable for sops.templates. This
# lets the calling profile wire sops-decrypted secrets at activation time
# without baking them into the nix store.
{ pkgs, mkK8sComponent }:

{ namespace ? "ceph-csi-rbd"
, monitors            # [ "10.0.0.10:6789" "10.0.0.11:6789" ... ]
, fsid                # Ceph cluster FSID
, pool ? "k8s-rbd"
, secretName ? "csi-rbd-secret"
, secretKey           # Ceph auth key (string — use sops.placeholder for runtime substitution)
, storageClassName ? "ceph-rbd"
, isDefaultClass ? true
}:

let
  lib = pkgs.lib;

  # --- Combinable components ---
  # ceph-csi execs `rbd` for krbd map/unmap — ceph (which provides rbd) must be in PATH.
  cephCsiEntrypoint = pkgs.writeShellScript "cephcsi-wrapper" ''
    export PATH="${pkgs.ceph}/bin:$PATH"
    exec ${pkgs.ceph-csi}/bin/cephcsi "$@"
  '';

  cephCsi = mkK8sComponent {
    name = "ceph-csi";
    entrypoint = "${cephCsiEntrypoint}";
    extraRootfs = "mkdir -p $out/etc/ceph";
  };

  provisioner = mkK8sComponent {
    name = "csi-provisioner";
    entrypoint = "${pkgs.csi-provisioner}/bin/csi-provisioner";
  };

  attacher = mkK8sComponent {
    name = "csi-attacher";
    entrypoint = "${pkgs.csi-attacher}/bin/csi-attacher";
  };

  resizer = mkK8sComponent {
    name = "csi-resizer";
    entrypoint = "${pkgs.csi-resizer}/bin/csi-resizer";
  };

  registrar = mkK8sComponent {
    name = "csi-node-driver-registrar";
    entrypoint = "${pkgs.csi-node-driver-registrar}/bin/csi-node-driver-registrar";
  };

  socketDir = { name = "socket-dir"; mountPath = "/csi"; };

  # --- k8s objects (static — no secrets) ---
  objects = {
    namespace = {
      apiVersion = "v1"; kind = "Namespace";
      metadata.name = namespace;
    };

    csiDriver = {
      apiVersion = "storage.k8s.io/v1"; kind = "CSIDriver";
      metadata.name = "rbd.csi.ceph.com";
      spec = {
        attachRequired = true;
        podInfoOnMount = false;
        fsGroupPolicy = "File";
      };
    };

    cephCsiConfig = {
      apiVersion = "v1"; kind = "ConfigMap";
      metadata = { name = "ceph-csi-config"; inherit namespace; };
      data."config.json" = builtins.toJSON [{
        clusterID = fsid;
        inherit monitors;
      }];
    };

    cephConfig = {
      apiVersion = "v1"; kind = "ConfigMap";
      metadata = { name = "ceph-config"; inherit namespace; };
      data."ceph.conf" = ''
        [global]
        auth_cluster_required = cephx
        auth_service_required = cephx
        auth_client_required = cephx
      '';
      data."keyring" = "";
    };

    encryptionKmsConfig = {
      apiVersion = "v1"; kind = "ConfigMap";
      metadata = { name = "ceph-csi-encryption-kms-config"; inherit namespace; };
      data."config.json" = "{}";
    };

    storageClass = {
      apiVersion = "storage.k8s.io/v1"; kind = "StorageClass";
      metadata = {
        name = storageClassName;
      } // lib.optionalAttrs isDefaultClass {
        annotations."storageclass.kubernetes.io/is-default-class" = "true";
      };
      provisioner = "rbd.csi.ceph.com";
      parameters = {
        clusterID = fsid;
        inherit pool;
        imageFeatures = "layering";
        "csi.storage.k8s.io/provisioner-secret-name" = secretName;
        "csi.storage.k8s.io/provisioner-secret-namespace" = namespace;
        "csi.storage.k8s.io/controller-expand-secret-name" = secretName;
        "csi.storage.k8s.io/controller-expand-secret-namespace" = namespace;
        "csi.storage.k8s.io/node-stage-secret-name" = secretName;
        "csi.storage.k8s.io/node-stage-secret-namespace" = namespace;
      };
      reclaimPolicy = "Delete";
      allowVolumeExpansion = true;
    };

    # --- RBAC ---

    provisionerServiceAccount = {
      apiVersion = "v1"; kind = "ServiceAccount";
      metadata = { name = "rbd-csi-provisioner"; inherit namespace; };
    };

    nodepluginServiceAccount = {
      apiVersion = "v1"; kind = "ServiceAccount";
      metadata = { name = "rbd-csi-nodeplugin"; inherit namespace; };
    };

    provisionerClusterRole = {
      apiVersion = "rbac.authorization.k8s.io/v1"; kind = "ClusterRole";
      metadata.name = "rbd-external-provisioner-runner";
      rules = [
        { apiGroups = [""]; resources = ["secrets"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = [""]; resources = ["persistentvolumes"]; verbs = ["get" "list" "watch" "create" "update" "delete" "patch"]; }
        { apiGroups = [""]; resources = ["persistentvolumeclaims"]; verbs = ["get" "list" "watch" "update"]; }
        { apiGroups = ["storage.k8s.io"]; resources = ["storageclasses"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = [""]; resources = ["events"]; verbs = ["list" "watch" "create" "update" "patch"]; }
        { apiGroups = ["snapshot.storage.k8s.io"]; resources = ["volumesnapshots"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = ["snapshot.storage.k8s.io"]; resources = ["volumesnapshotcontents"]; verbs = ["create" "get" "list" "watch" "update" "delete" "patch"]; }
        { apiGroups = ["snapshot.storage.k8s.io"]; resources = ["volumesnapshotclasses"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = ["storage.k8s.io"]; resources = ["csinodes"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = [""]; resources = ["nodes"]; verbs = ["get" "list" "watch"]; }
        { apiGroups = ["storage.k8s.io"]; resources = ["volumeattachments"]; verbs = ["get" "list" "watch" "patch"]; }
        { apiGroups = ["storage.k8s.io"]; resources = ["volumeattachments/status"]; verbs = ["patch"]; }
        { apiGroups = [""]; resources = ["persistentvolumeclaims/status"]; verbs = ["patch"]; }
        { apiGroups = ["coordination.k8s.io"]; resources = ["leases"]; verbs = ["get" "watch" "list" "delete" "update" "create"]; }
      ];
    };

    provisionerClusterRoleBinding = {
      apiVersion = "rbac.authorization.k8s.io/v1"; kind = "ClusterRoleBinding";
      metadata.name = "rbd-csi-provisioner-role";
      subjects = [{ kind = "ServiceAccount"; name = "rbd-csi-provisioner"; inherit namespace; }];
      roleRef = { kind = "ClusterRole"; name = "rbd-external-provisioner-runner"; apiGroup = "rbac.authorization.k8s.io"; };
    };

    nodepluginClusterRole = {
      apiVersion = "rbac.authorization.k8s.io/v1"; kind = "ClusterRole";
      metadata.name = "rbd-csi-nodeplugin";
      rules = [
        { apiGroups = [""]; resources = ["nodes"]; verbs = ["get"]; }
        { apiGroups = [""]; resources = ["secrets"]; verbs = ["get"]; }
        { apiGroups = [""]; resources = ["configmaps"]; verbs = ["get"]; }
        { apiGroups = [""]; resources = ["serviceaccounts"]; verbs = ["get"]; }
        { apiGroups = [""]; resources = ["persistentvolumes"]; verbs = ["get"]; }
        { apiGroups = ["storage.k8s.io"]; resources = ["volumeattachments"]; verbs = ["list"]; }
      ];
    };

    nodepluginClusterRoleBinding = {
      apiVersion = "rbac.authorization.k8s.io/v1"; kind = "ClusterRoleBinding";
      metadata.name = "rbd-csi-nodeplugin";
      subjects = [{ kind = "ServiceAccount"; name = "rbd-csi-nodeplugin"; inherit namespace; }];
      roleRef = { kind = "ClusterRole"; name = "rbd-csi-nodeplugin"; apiGroup = "rbac.authorization.k8s.io"; };
    };

    # --- Provisioner controller (Deployment) ---

    provisionerDeployment = {
      apiVersion = "apps/v1"; kind = "Deployment";
      metadata = { name = "csi-rbdplugin-provisioner"; inherit namespace; };
      spec = {
        replicas = 1;
        selector.matchLabels.app = "csi-rbdplugin-provisioner";
        template = {
          metadata.labels.app = "csi-rbdplugin-provisioner";
          spec = {
            serviceAccountName = "rbd-csi-provisioner";
            containers = [
              (provisioner.container {
                args = [
                  "--csi-address=/csi/csi.sock"
                  "--leader-election=true"
                  "--extra-create-metadata=true"
                  "--feature-gates=Topology=false"
                  "--timeout=150s"
                ];
                volumeMounts = [ socketDir ];
              })
              (attacher.container {
                args = [
                  "--csi-address=/csi/csi.sock"
                  "--leader-election=true"
                ];
                volumeMounts = [ socketDir ];
              })
              (resizer.container {
                args = [
                  "--csi-address=/csi/csi.sock"
                  "--leader-election=true"
                ];
                volumeMounts = [ socketDir ];
              })
              (cephCsi.container {
                name = "csi-rbdplugin";
                args = [
                  "--type=rbd"
                  "--drivername=rbd.csi.ceph.com"
                  "--endpoint=unix:///csi/csi.sock"
                  "--nodeid=$(NODE_ID)"
                  "--controllerserver=true"
                ];
                env = [
                  { name = "NODE_ID"; valueFrom.fieldRef.fieldPath = "spec.nodeName"; }
                  { name = "POD_NAMESPACE"; valueFrom.fieldRef.fieldPath = "metadata.namespace"; }
                ];
                volumeMounts = [
                  socketDir
                  { name = "ceph-csi-config"; mountPath = "/etc/ceph-csi-config"; }
                  { name = "ceph-config"; mountPath = "/etc/ceph"; }
                  { name = "keys-tmp-dir"; mountPath = "/tmp/csi/keys"; }
                  { name = "ceph-csi-kms-config"; mountPath = "/etc/ceph-csi-encryption-kms-config"; }
                ];
              })
            ];
            volumes = [
              { name = "socket-dir"; emptyDir.medium = "Memory"; }
              { name = "ceph-csi-config"; configMap.name = "ceph-csi-config"; }
              { name = "ceph-config"; configMap.name = "ceph-config"; }
              { name = "ceph-csi-kms-config"; configMap.name = "ceph-csi-encryption-kms-config"; }
              { name = "keys-tmp-dir"; emptyDir.medium = "Memory"; }
            ];
          };
        };
      };
    };

    # --- Node plugin (DaemonSet) ---

    nodepluginDaemonSet = {
      apiVersion = "apps/v1"; kind = "DaemonSet";
      metadata = { name = "csi-rbdplugin"; inherit namespace; };
      spec = {
        selector.matchLabels.app = "csi-rbdplugin";
        template = {
          metadata.labels.app = "csi-rbdplugin";
          spec = {
            serviceAccountName = "rbd-csi-nodeplugin";
            hostNetwork = true;
            dnsPolicy = "ClusterFirstWithHostNet";
            containers = [
              (registrar.container {
                args = [
                  "--csi-address=/csi/csi.sock"
                  "--kubelet-registration-path=/var/lib/kubelet/plugins/rbd.csi.ceph.com/csi.sock"
                ];
                securityContext.privileged = true;
                volumeMounts = [
                  socketDir
                  { name = "registration-dir"; mountPath = "/registration"; }
                ];
              })
              (cephCsi.container {
                name = "csi-rbdplugin";
                args = [
                  "--type=rbd"
                  "--drivername=rbd.csi.ceph.com"
                  "--endpoint=unix:///csi/csi.sock"
                  "--nodeid=$(NODE_ID)"
                  "--nodeserver=true"
                ];
                securityContext.privileged = true;
                env = [
                  { name = "NODE_ID"; valueFrom.fieldRef.fieldPath = "spec.nodeName"; }
                ];
                volumeMounts = [
                  socketDir
                  { name = "plugin-dir"; mountPath = "/var/lib/kubelet/plugins"; mountPropagation = "Bidirectional"; }
                  { name = "pods-mount-dir"; mountPath = "/var/lib/kubelet/pods"; mountPropagation = "Bidirectional"; }
                  { name = "host-dev"; mountPath = "/dev"; }
                  { name = "host-sys"; mountPath = "/sys"; }
                  { name = "lib-modules"; mountPath = "/lib/modules"; readOnly = true; }
                  { name = "ceph-csi-config"; mountPath = "/etc/ceph-csi-config"; }
                  { name = "ceph-config"; mountPath = "/etc/ceph"; }
                  { name = "ceph-csi-kms-config"; mountPath = "/etc/ceph-csi-encryption-kms-config"; }
                  { name = "keys-tmp-dir"; mountPath = "/tmp/csi/keys"; }
                ];
              })
            ];
            volumes = [
              { name = "socket-dir"; hostPath = { path = "/var/lib/kubelet/plugins/rbd.csi.ceph.com"; type = "DirectoryOrCreate"; }; }
              { name = "registration-dir"; hostPath = { path = "/var/lib/kubelet/plugins_registry"; type = "Directory"; }; }
              { name = "plugin-dir"; hostPath = { path = "/var/lib/kubelet/plugins"; type = "Directory"; }; }
              { name = "pods-mount-dir"; hostPath = { path = "/var/lib/kubelet/pods"; type = "Directory"; }; }
              { name = "host-dev"; hostPath.path = "/dev"; }
              { name = "host-sys"; hostPath.path = "/sys"; }
              { name = "lib-modules"; hostPath = { path = "/run/current-system/kernel-modules/lib/modules"; type = "Directory"; }; }
              { name = "ceph-csi-config"; configMap.name = "ceph-csi-config"; }
              { name = "ceph-config"; configMap.name = "ceph-config"; }
              { name = "ceph-csi-kms-config"; configMap.name = "ceph-csi-encryption-kms-config"; }
              { name = "keys-tmp-dir"; emptyDir.medium = "Memory"; }
            ];
          };
        };
      };
    };
  };

  # Ordered manifest list for kubectl apply (secret excluded — applied via sops template)
  orderedNames = [
    "namespace"
    "csiDriver"
    "provisionerServiceAccount"
    "nodepluginServiceAccount"
    "provisionerClusterRole"
    "provisionerClusterRoleBinding"
    "nodepluginClusterRole"
    "nodepluginClusterRoleBinding"
    "cephCsiConfig"
    "cephConfig"
    "encryptionKmsConfig"
    "storageClass"
    "provisionerDeployment"
    "nodepluginDaemonSet"
  ];

  manifestFiles = lib.imap0 (i: name:
    let
      obj = objects.${name};
      prefix = lib.fixedWidthString 2 "0" (toString i);
    in pkgs.writeText "${prefix}-${name}.json" (builtins.toJSON obj)
  ) orderedNames;

in {
  inherit objects namespace secretName;

  manifests = pkgs.runCommand "ceph-csi-rbd-manifests" {} ''
    mkdir -p $out
    ${lib.concatMapStringsSep "\n"
      (f: "cp ${f} $out/${f.name}") manifestFiles}
  '';

  # JSON string for the k8s Secret — use with sops.templates so the key
  # is substituted at activation time, not baked into the nix store.
  # The caller passes secretKey = config.sops.placeholder."ceph/csi-k8s-key"
  # which sops-nix replaces with the decrypted value at activation.
  secretManifestJSON = builtins.toJSON {
    apiVersion = "v1"; kind = "Secret";
    metadata = { name = secretName; inherit namespace; };
    stringData = {
      userID = "k8s";
      userKey = secretKey;
    };
  };

  images = [ cephCsi.image provisioner.image attacher.image resizer.image registrar.image ];

  hostConfig = {
    kernelModules = [ "rbd" ];
  };
}
