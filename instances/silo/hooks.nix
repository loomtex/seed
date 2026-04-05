# Git hooks — global hooks applied to all silo repos
#
# Pre-receive: CODEOWNERS gating — non-owner, non-CODEOWNERS keys can only push
#   to gate/* branches and refs/dit/*. Protected branches require key in CODEOWNERS.
# Post-receive: syncs .authorized_keys from tree, fires webhook to controller.
# Installed via core.hooksPath — users can't override.
{ config, pkgs, lib, reposDir, ... }:

let
  preReceiveHook = pkgs.writeShellScript "pre-receive" ''
    set -euo pipefail

    REPO_DIR=$(${pkgs.coreutils}/bin/realpath "$GIT_DIR")

    KEY_BLOB="''${SILO_KEY_BLOB:-}"
    if [ -z "$KEY_BLOB" ]; then
      echo "silo: no key identity — cannot verify CODEOWNERS" >&2
      exit 1
    fi

    # Owner key always passes — no gating
    OWNER_KEY_FILE="$REPO_DIR/.owner_key"
    if [ -f "$OWNER_KEY_FILE" ]; then
      OWNER_BLOB=$(${pkgs.coreutils}/bin/cut -d' ' -f2 < "$OWNER_KEY_FILE")
      if [ "$KEY_BLOB" = "$OWNER_BLOB" ]; then
        exit 0
      fi
    fi

    # Read all ref updates, check each one
    REJECTED=false
    while read OLD NEW REF; do
      # Always allow dit refs and gate branches
      case "$REF" in
        refs/dit/*|refs/heads/gate/*) continue ;;
      esac

      # Protected branch — check CODEOWNERS from current HEAD
      if ! ${pkgs.git}/bin/git -C "$REPO_DIR" cat-file -e HEAD:CODEOWNERS 2>/dev/null; then
        # No CODEOWNERS file — no gating configured, allow
        continue
      fi

      # CODEOWNERS exists — check if pushing key is listed
      if ${pkgs.git}/bin/git -C "$REPO_DIR" show HEAD:CODEOWNERS \
        | ${pkgs.gnugrep}/bin/grep -v '^#' \
        | ${pkgs.gnugrep}/bin/grep -qF "$KEY_BLOB"; then
        continue
      fi

      # Not in CODEOWNERS — reject
      BRANCH_NAME="''${REF#refs/heads/}"
      echo "silo: push to $REF rejected — not in CODEOWNERS" >&2
      echo "silo: push to gate/$BRANCH_NAME instead for review" >&2
      REJECTED=true
    done

    if [ "$REJECTED" = "true" ]; then
      exit 1
    fi
  '';

  postReceiveHook = pkgs.writeShellScript "post-receive" ''
    REPO_DIR=$(${pkgs.coreutils}/bin/realpath "$GIT_DIR")
    REPO_NAME=$(${pkgs.coreutils}/bin/basename "$REPO_DIR" .git)
    DEFAULT_BRANCH=$(${pkgs.git}/bin/git -C "$REPO_DIR" symbolic-ref HEAD 2>/dev/null || echo "refs/heads/master")

    # Parse ref updates from stdin — find the default branch push
    # Track whether any non-dit ref was updated (dit = issue tracking refs)
    HEAD_SHA=""
    NON_DIT_PUSH=false
    while read OLD NEW REF; do
      case "$REF" in
        refs/dit/*) ;;  # issue refs — skip
        *) NON_DIT_PUSH=true ;;
      esac
      if [ "$REF" = "$DEFAULT_BRANCH" ]; then
        HEAD_SHA="$NEW"
      fi
    done

    # --- Sync .authorized_keys from tree to bare repo metadata ---
    # Owner key (.owner_key) always grants push regardless.
    # .authorized_keys in the tree is for collaborators — additive only.
    if [ -n "$HEAD_SHA" ] && ${pkgs.git}/bin/git -C "$REPO_DIR" cat-file -e "$HEAD_SHA:.authorized_keys" 2>/dev/null; then
      ${pkgs.git}/bin/git -C "$REPO_DIR" show "$HEAD_SHA:.authorized_keys" > "$REPO_DIR/.authorized_keys"
    fi

    # --- Webhook to seed-controller ---
    # Skip if only issue refs (refs/dit/*) were updated
    [ "$NON_DIT_PUSH" = "false" ] && exit 0

    SECRET_FILE="/run/secrets/silo-webhook-secret"
    [ ! -f "$SECRET_FILE" ] && exit 0
    SECRET=$(${pkgs.coreutils}/bin/cat "$SECRET_FILE")

    BODY="{\"repository\":{\"full_name\":\"$REPO_NAME\"}}"
    SIGNATURE="sha256=$(${pkgs.coreutils}/bin/printf '%s' "$BODY" | ${pkgs.openssl}/bin/openssl dgst -sha256 -hmac "$SECRET" -hex 2>/dev/null | ${pkgs.gawk}/bin/awk '{print $NF}')"

    ${pkgs.curl}/bin/curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "X-Hub-Signature-256: $SIGNATURE" \
      -d "$BODY" \
      "https://seed-controller.seed-system.svc.cluster.local:9876/refresh" \
      >/dev/null 2>&1 || true
  '';

in {
  environment.etc."gitconfig".text = ''
    [core]
      hooksPath = /etc/silo/hooks
  '';
  environment.etc."silo/hooks/pre-receive" = {
    source = preReceiveHook;
    mode = "0755";
  };
  environment.etc."silo/hooks/post-receive" = {
    source = postReceiveHook;
    mode = "0755";
  };
}
