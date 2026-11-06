set -eu
# Egress pools give dockerd a default bridge with a fixed range outside Docker's
# default address pools. Only BuildKit `RUN` steps use it: graph containers always
# name an owned network or `none`, and the engine client refuses any other create.
# guest-build-network.sh isolates it after the engine starts. Isolated pools keep
# no default bridge, so builds refuse there.
case "${1-}" in
  isolated) gateway_rules=false; set -- --bridge=none ;;
  approved-hosts|internet) gateway_rules=true; set -- --bip=10.213.255.1/24 --icc=false ;;
  host-gateway) gateway_rules=true; set -- --bip=10.213.255.1/24 --icc=false --host-gateway-ip=100.96.0.1 ;;
  *) exit 64 ;;
esac
dockerd --storage-driver=overlay2 --data-root=/var/lib/docker \
  --iptables="$gateway_rules" --ip6tables=false \
  --ip-forward="$gateway_rules" --ip-masq="$gateway_rules" "$@" \
  --exec-root=/run/hack-local/exec --pidfile=/run/hack-local/docker.pid \
  --host=unix:///run/hack-local/docker.sock --log-level=warn \
  2>&1 | {
  # Keep a bounded startup diagnostic prefix, then drain without closing the
  # pipe: hitting the log cap must never deliver SIGPIPE to the engine.
  head -c 5242880 >/storage/hack-local-dockerd.log
  cat >/dev/null
}
