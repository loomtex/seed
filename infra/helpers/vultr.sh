# Vultr REST API helper for seed infrastructure.
# Used as a flake app: nix run .#vultr -- <command> [args...]
#
# Commands:
#   create-vpc <region> <subnet>     Create a VPC v1
#   create-vm <label> <plan> <region> <vpc-id>  Create a VM in a VPC
#   create-bm <label> <plan> <region> <vpc-id> <boot-script-id>  Create bare metal
#   create-boot-script <name> <script-content>  Create iPXE boot script
#   destroy <type> <id>              Destroy a resource (vm|bm|vpc)
#   list <type>                      List resources (vms|bms|vpcs)
#   get <type> <id>                  Get resource details
#   attach-vpc <instance-id> <vpc-id>  Attach VPC to instance
#   detach-vpc <instance-id> <vpc-id>  Detach VPC from instance

VULTR_API="https://api.vultr.com/v2"

if [ -z "${VULTR_API_KEY:-}" ]; then
  if [ -f "${VULTR_API_KEY_FILE:-/dev/null}" ]; then
    VULTR_API_KEY=$(cat "$VULTR_API_KEY_FILE")
  else
    echo "error: VULTR_API_KEY or VULTR_API_KEY_FILE must be set" >&2
    exit 1
  fi
fi

vultr() {
  curl -sf -H "Authorization: Bearer $VULTR_API_KEY" "$@"
}

case "${1:-help}" in
  create-vpc)
    REGION="${2:?region required}"
    SUBNET="${3:?subnet required (e.g. 10.0.0.0)}"
    MASK="${4:-24}"
    vultr -X POST "$VULTR_API/private-networks" \
      -H "Content-Type: application/json" \
      -d "{\"region\":\"$REGION\",\"v4_subnet\":\"$SUBNET\",\"v4_subnet_mask\":$MASK,\"description\":\"seed-$REGION\"}" | jq .
    ;;

  create-vm)
    LABEL="${2:?label required}"
    PLAN="${3:?plan required}"
    REGION="${4:?region required}"
    VPC_ID="${5:-}"
    OS_ID="${6:-2136}"  # Debian 12
    ATTACH=""
    if [ -n "$VPC_ID" ]; then
      ATTACH=",\"attach_private_network\":[\"$VPC_ID\"]"
    fi
    # Always include all registered SSH keys (key auth only)
    SSH_KEYS=$(vultr "$VULTR_API/ssh-keys" | jq -c '[.ssh_keys[].id]')
    vultr -X POST "$VULTR_API/instances" \
      -H "Content-Type: application/json" \
      -d "{\"label\":\"$LABEL\",\"plan\":\"$PLAN\",\"region\":\"$REGION\",\"os_id\":$OS_ID,\"sshkey_id\":$SSH_KEYS$ATTACH}" | jq .
    ;;

  create-bm)
    LABEL="${2:?label required}"
    PLAN="${3:?plan required}"
    REGION="${4:?region required}"
    VPC_ID="${5:-}"
    SCRIPT_ID="${6:-}"
    ATTACH=""
    if [ -n "$VPC_ID" ]; then
      ATTACH=",\"attach_private_network\":[\"$VPC_ID\"]"
    fi
    SCRIPT=""
    if [ -n "$SCRIPT_ID" ]; then
      SCRIPT=",\"script_id\":\"$SCRIPT_ID\""
    fi
    SSH_KEYS=$(vultr "$VULTR_API/ssh-keys" | jq -c '[.ssh_keys[].id]')
    vultr -X POST "$VULTR_API/bare-metals" \
      -H "Content-Type: application/json" \
      -d "{\"label\":\"$LABEL\",\"plan\":\"$PLAN\",\"region\":\"$REGION\",\"os_id\":159,\"sshkey_id\":$SSH_KEYS$ATTACH$SCRIPT}" | jq .
    ;;

  create-boot-script)
    NAME="${2:?name required}"
    SCRIPT="${3:?script content required}"
    vultr -X POST "$VULTR_API/startup-scripts" \
      -H "Content-Type: application/json" \
      -d "{\"name\":\"$NAME\",\"type\":\"pxe\",\"script\":\"$(echo "$SCRIPT" | base64 -w0)\"}" | jq .
    ;;

  destroy)
    TYPE="${2:?type required (vm|bm|vpc)}"
    ID="${3:?id required}"
    case "$TYPE" in
      vm)  vultr -X DELETE "$VULTR_API/instances/$ID" ;;
      bm)  vultr -X DELETE "$VULTR_API/bare-metals/$ID" ;;
      vpc) vultr -X DELETE "$VULTR_API/private-networks/$ID" ;;
      *)   echo "Unknown type: $TYPE" >&2; exit 1 ;;
    esac
    echo "Destroyed $TYPE $ID"
    ;;

  list)
    TYPE="${2:?type required (vms|bms|vpcs)}"
    case "$TYPE" in
      vms)  vultr "$VULTR_API/instances?per_page=500" | jq '.instances[] | {id, label, main_ip, status, region}' ;;
      bms)  vultr "$VULTR_API/bare-metals?per_page=500" | jq '.bare_metals[] | {id, label, main_ip, status, region}' ;;
      vpcs) vultr "$VULTR_API/private-networks?per_page=500" | jq '.networks[] | {id, description, v4_subnet, region}' ;;
      *)    echo "Unknown type: $TYPE" >&2; exit 1 ;;
    esac
    ;;

  get)
    TYPE="${2:?type required (vm|bm|vpc)}"
    ID="${3:?id required}"
    case "$TYPE" in
      vm)  vultr "$VULTR_API/instances/$ID" | jq . ;;
      bm)  vultr "$VULTR_API/bare-metals/$ID" | jq . ;;
      vpc) vultr "$VULTR_API/private-networks/$ID" | jq . ;;
      *)   echo "Unknown type: $TYPE" >&2; exit 1 ;;
    esac
    ;;

  attach-vpc)
    INSTANCE_ID="${2:?instance-id required}"
    VPC_ID="${3:?vpc-id required}"
    vultr -X POST "$VULTR_API/instances/$INSTANCE_ID/private-networks/attach" \
      -H "Content-Type: application/json" \
      -d "{\"network_id\":\"$VPC_ID\"}"
    echo "Attached VPC $VPC_ID to instance $INSTANCE_ID"
    ;;

  detach-vpc)
    INSTANCE_ID="${2:?instance-id required}"
    VPC_ID="${3:?vpc-id required}"
    vultr -X POST "$VULTR_API/instances/$INSTANCE_ID/private-networks/detach" \
      -H "Content-Type: application/json" \
      -d "{\"network_id\":\"$VPC_ID\"}"
    echo "Detached VPC $VPC_ID from instance $INSTANCE_ID"
    ;;

  help|*)
    echo "Usage: seed-vultr <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  create-vpc <region> <subnet> [mask]"
    echo "  create-vm <label> <plan> <region> [vpc-id] [os-id]"
    echo "  create-bm <label> <plan> <region> [vpc-id] [script-id]"
    echo "  create-boot-script <name> <script-content>"
    echo "  destroy <type:vm|bm|vpc> <id>"
    echo "  list <type:vms|bms|vpcs>"
    echo "  get <type:vm|bm|vpc> <id>"
    echo "  attach-vpc <instance-id> <vpc-id>"
    echo "  detach-vpc <instance-id> <vpc-id>"
    echo ""
    echo "Environment: VULTR_API_KEY or VULTR_API_KEY_FILE"
    ;;
esac
