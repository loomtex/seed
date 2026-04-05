# Git hooks — global hooks applied to all silo repos
#
# Post-receive: syncs .authorized_keys from tree, fires webhook to controller.
# Installed via core.hooksPath — users can't override.
{ config, pkgs, lib, reposDir, ... }:

let
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
  environment.etc."silo/hooks/post-receive" = {
    source = postReceiveHook;
    mode = "0755";
  };
}
