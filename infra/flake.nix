{
  description = "Seed cluster infrastructure — Pulumi IaC for bare metal provisioning";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs }:
  let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };

    # Wrapper that handles sops passphrase + local backend
    pulumiWrapper = pkgs.writeShellScriptBin "pu" ''
      set -euo pipefail

      SCRIPT_DIR="$(cd "$(dirname "''${BASH_SOURCE[0]}")" && pwd)"
      INFRA_DIR="''${SEED_INFRA_DIR:-$(pwd)}"
      MYNIX_DIR="''${MYNIX_DIR:-/agents/ada/projects/mynix}"
      SOPS_FILE="$MYNIX_DIR/secrets/pulumi-passphrase.yaml"
      STATE_DIR="$INFRA_DIR/.pulumi-state"

      if [[ ! -f "$SOPS_FILE" ]]; then
        echo "error: sops passphrase file not found: $SOPS_FILE" >&2
        echo "hint: set MYNIX_DIR to your mynix repo root" >&2
        exit 1
      fi

      # Find age key for sops decryption
      export SOPS_AGE_KEY_FILE="''${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
      if [[ ! -f "$SOPS_AGE_KEY_FILE" ]]; then
        echo "error: age key not found: $SOPS_AGE_KEY_FILE" >&2
        echo "hint: set SOPS_AGE_KEY_FILE or place your key at ~/.config/sops/age/keys.txt" >&2
        exit 1
      fi

      # Decrypt passphrase directly into env (never in shell history)
      export PULUMI_CONFIG_PASSPHRASE
      PULUMI_CONFIG_PASSPHRASE="$(${pkgs.sops}/bin/sops --decrypt --extract '["pulumi-passphrase"]' "$SOPS_FILE")"

      export PULUMI_BACKEND_URL="file://$STATE_DIR"
      export PULUMI_HOME="''${PULUMI_HOME:-$STATE_DIR/.home}"

      mkdir -p "$STATE_DIR" "$PULUMI_HOME"

      # Ensure Pulumi plugins are on PATH
      export PATH="${pkgs.pulumiPackages.pulumi-language-nodejs}/bin:${pkgs.nodejs_22}/bin:$PATH"

      # Auto-login to local backend and select stack
      ${pkgs.pulumi}/bin/pulumi login "$PULUMI_BACKEND_URL" 2>/dev/null
      ${pkgs.pulumi}/bin/pulumi stack select prod 2>/dev/null || true

      cd "$INFRA_DIR"
      exec ${pkgs.pulumi}/bin/pulumi "$@"
    '';
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = [
        pkgs.pulumi
        pkgs.pulumiPackages.pulumi-language-nodejs
        pkgs.nodejs_22
        pkgs.sops
        pkgs.awscli2
        pkgs.openssh
        pkgs.ssh-to-age
        pulumiWrapper
      ];

      shellHook = ''
        export PULUMI_BACKEND_URL="file://$(pwd)/.pulumi-state"
        export PULUMI_HOME="$(pwd)/.pulumi-state/.home"
        mkdir -p .pulumi-state/.home

        echo "Seed infra devshell"
        echo "  pu preview   — preview changes"
        echo "  pu up        — apply changes"
        echo "  pu destroy   — tear down"
        echo "  pu config    — manage config"
      '';
    };

    # Standalone scripts (usable without entering devshell)
    packages.${system} = {
      pu = pulumiWrapper;
    };

    apps.${system} = {
      preview = {
        type = "app";
        program = "${pkgs.writeShellScript "preview" ''
          exec ${pulumiWrapper}/bin/pu preview "$@"
        ''}";
      };
      up = {
        type = "app";
        program = "${pkgs.writeShellScript "up" ''
          exec ${pulumiWrapper}/bin/pu up "$@"
        ''}";
      };
    };
  };
}
