set -eu
case "${1-}" in
  isolated) gateway_rules=false; set -- ;;
  approved-hosts) gateway_rules=true; set -- ;;
  host-gateway) gateway_rules=true; set -- --host-gateway-ip=100.96.0.1 ;;
  *) exit 64 ;;
esac
exec dockerd --storage-driver=overlay2 --data-root=/var/lib/docker \
  --bridge=none --iptables="$gateway_rules" --ip6tables=false \
  --ip-forward="$gateway_rules" --ip-masq="$gateway_rules" "$@" \
  --exec-root=/run/hack-local/exec --pidfile=/run/hack-local/docker.pid \
  --host=unix:///run/hack-local/docker.sock --log-level=warn \
  >/storage/hack-local-dockerd.log 2>&1
