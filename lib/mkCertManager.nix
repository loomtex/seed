# mkCertManager — cert-manager deployment via Helm template at build time.
#
# Uses the official cert-manager Helm chart for manifest generation,
# templated with values from the nix function call. Container images
# are built from source via nix-snapshotter (no registry pulls).
#
# Helm is a build-time tool here — no Tiller, no runtime dependency.
{ pkgs, mkK8sComponent }:

{ namespace ? "cert-manager"
, version ? "1.17.2"
, installCRDs ? true
, replicaCount ? 1
, extraValues ? {}      # Additional Helm values (attrset, merged last)
}:

let
  lib = pkgs.lib;

  # --- cert-manager from source ---

  certManagerSrc = pkgs.fetchFromGitHub {
    owner = "cert-manager";
    repo = "cert-manager";
    rev = "v${version}";
    hash = "sha256-ysEV9qKJ08ugtg5CmZKR+YkJAec6pzDalFlph9hGqNQ=";
  };

  # Each cert-manager binary is a separate Go module under cmd/
  buildCertManagerBin = name: vendorHash: pkgs.buildGoModule {
    pname = "cert-manager-${name}";
    inherit version;
    src = certManagerSrc;
    sourceRoot = "${certManagerSrc.name}/cmd/${name}";
    inherit vendorHash;
    ldflags = [ "-s" "-w" ];
    doCheck = false;
  };

  controllerBin = buildCertManagerBin "controller" "sha256-SW/LNkAwq1A2Ua2v6fPIl9y+arcbauLk5F0wANLNSRU=";
  webhookBin = buildCertManagerBin "webhook" "sha256-BPCsFK+Hb83vg3H0h08JxRmM9032WtA6smyjbzTENFo=";
  cainjectorBin = buildCertManagerBin "cainjector" "sha256-l3EDiQEkEzZLUkQNz6rr3H1DM0rOU4OKXpIcKnJ/FSI=";
  startupapicheckBin = buildCertManagerBin "startupapicheck" "sha256-kNw+jih+YCuxbnoYmsk9hdJwF6H3+7T87FtxlAif+1I=";

  # --- nix-snapshotter images ---

  controller = mkK8sComponent {
    name = "cert-manager-controller";
    entrypoint = "${controllerBin}/bin/controller-binary";
  };

  webhook = mkK8sComponent {
    name = "cert-manager-webhook";
    entrypoint = "${webhookBin}/bin/webhook-binary";
  };

  cainjector = mkK8sComponent {
    name = "cert-manager-cainjector";
    entrypoint = "${cainjectorBin}/bin/cainjector-binary";
  };

  startupapicheck = mkK8sComponent {
    name = "cert-manager-startupapicheck";
    entrypoint = "${startupapicheckBin}/bin/startupapicheck-binary";
  };

  # --- Helm chart for manifest generation ---

  chartSrc = pkgs.fetchurl {
    url = "https://charts.jetstack.io/charts/cert-manager-v${version}.tgz";
    hash = "sha256-n46q2nhahwESx7GHSVK36Hdv0GZgg2HIPs7oWTFDk60=";
  };

  # Nix-snapshotter images run as root; override Helm's runAsNonRoot.
  securityContext = { runAsNonRoot = false; seccompProfile.type = "RuntimeDefault"; };

  values = lib.recursiveUpdate {
    installCRDs = installCRDs;
    replicaCount = replicaCount;
    global.imagePullPolicy = "Never";
    securityContext = securityContext;
    webhook.securityContext = securityContext;
    cainjector.securityContext = securityContext;
    startupapicheck.securityContext = securityContext;
  } extraValues;

  # Image ref replacements: sed the rendered manifests to swap quay.io
  # images for nix-snapshotter refs. Simpler than fighting Helm's
  # repository:tag concatenation logic.
  imageReplacements = [
    { from = "quay.io/jetstack/cert-manager-controller:v${version}"; to = controller.imageRef; }
    { from = "quay.io/jetstack/cert-manager-cainjector:v${version}"; to = cainjector.imageRef; }
    { from = "quay.io/jetstack/cert-manager-webhook:v${version}"; to = webhook.imageRef; }
    { from = "quay.io/jetstack/cert-manager-startupapicheck:v${version}"; to = startupapicheck.imageRef; }
  ];

  sedExpr = lib.concatMapStringsSep " " (r:
    "-e 's|${r.from}|${r.to}|g'"
  ) imageReplacements;

  valuesFile = pkgs.writeText "cert-manager-values.json" (builtins.toJSON values);

  # Render the Helm chart to static manifests at build time.
  renderedManifests = pkgs.runCommand "cert-manager-manifests" {
    nativeBuildInputs = [ pkgs.kubernetes-helm ];
  } ''
    mkdir -p $out

    helm template cert-manager ${chartSrc} \
      --namespace ${namespace} \
      --create-namespace \
      --values ${valuesFile} \
      --output-dir /tmp/rendered

    DIR=/tmp/rendered/cert-manager/templates

    # Ordered apply: CRDs → namespace → supporting resources → workloads → webhooks
    i=0
    emit() {
      local src="$DIR/$1"
      [ -f "$src" ] && [ -s "$src" ] || return 0
      sed ${sedExpr} "$src" > "$out/$(printf '%03d' $i)-$1"
      i=$((i + 1))
    }

    # 1. CRDs
    emit crds.yaml

    # 2. Namespace
    cat > "$out/$(printf '%03d' $i)-namespace.yaml" <<EOF
    apiVersion: v1
    kind: Namespace
    metadata:
      name: ${namespace}
    EOF
    i=$((i + 1))

    # 3. ServiceAccounts
    emit serviceaccount.yaml
    emit cainjector-serviceaccount.yaml
    emit webhook-serviceaccount.yaml

    # 4. RBAC
    emit rbac.yaml
    emit cainjector-rbac.yaml
    emit webhook-rbac.yaml

    # 5. Services
    emit service.yaml
    emit cainjector-service.yaml
    emit webhook-service.yaml

    # 6. Deployments
    emit deployment.yaml
    emit cainjector-deployment.yaml
    emit webhook-deployment.yaml

    # 7. Webhook configurations
    emit webhook-mutating-webhook.yaml
    emit webhook-validating-webhook.yaml

    # 8. Startup check
    emit startupapicheck-serviceaccount.yaml
    emit startupapicheck-rbac.yaml
    emit startupapicheck-job.yaml
  '';

  # Self-signed ClusterIssuer + CA issuer for internal platform PKI.
  # Uses a k8s List to bundle multiple resources in one file.
  platformCA = pkgs.writeText "seed-platform-ca.json" (builtins.toJSON {
    apiVersion = "v1";
    kind = "List";
    items = [
      # Bootstrap self-signed issuer
      {
        apiVersion = "cert-manager.io/v1";
        kind = "ClusterIssuer";
        metadata.name = "seed-selfsigned";
        spec.selfSigned = {};
      }
      # Self-signed root CA certificate
      {
        apiVersion = "cert-manager.io/v1";
        kind = "Certificate";
        metadata = {
          name = "seed-root-ca";
          inherit namespace;
        };
        spec = {
          isCA = true;
          commonName = "Seed Platform Root CA";
          secretName = "seed-root-ca";
          duration = "87600h";    # 10 years
          renewBefore = "8760h";  # 1 year
          privateKey = {
            algorithm = "ECDSA";
            size = 256;
          };
          issuerRef = {
            name = "seed-selfsigned";
            kind = "ClusterIssuer";
            group = "cert-manager.io";
          };
        };
      }
      # CA issuer that signs leaf certs with the root CA
      {
        apiVersion = "cert-manager.io/v1";
        kind = "ClusterIssuer";
        metadata.name = "seed-ca";
        spec.ca.secretName = "seed-root-ca";
      }
    ];
  });

in {
  manifests = renderedManifests;
  inherit namespace platformCA;
  images = [ controller.image webhook.image cainjector.image startupapicheck.image ];
}
