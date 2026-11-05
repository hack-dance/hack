set -eu
# Isolate the build bridge (docker0) that only BuildKit `RUN` steps use. Docker's
# own isolation chains already drop docker0 <-> owned project bridges; these rules
# also drop build traffic to the guest itself (relays, sockets, the engine), to
# the host gateway and to link-local metadata, while allowing DNS to the guest's
# configured resolvers. External reach is then only what the VM boundary allows.
# Arguments: network mode, guest boot ID. The marker binds the rules to this boot.
case "${1-}" in
  isolated) exit 0 ;;
  approved-hosts|internet|host-gateway) ;;
  *) exit 64 ;;
esac
test -d /sys/class/net/docker0
marker=/run/hack-local/build-network
for chain in HACK-BUILD-FORWARD HACK-BUILD-INPUT; do
  iptables -N "$chain" 2>/dev/null || iptables -F "$chain"
done
for resolver in $(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf); do
  case "$resolver" in *:*|127.*) continue ;; esac
  for protocol in udp tcp; do
    iptables -A HACK-BUILD-FORWARD -d "$resolver" -p "$protocol" --dport 53 -j RETURN
    iptables -A HACK-BUILD-INPUT -d "$resolver" -p "$protocol" --dport 53 -j ACCEPT
  done
done
iptables -A HACK-BUILD-FORWARD -d 100.96.0.1 -j DROP
iptables -A HACK-BUILD-FORWARD -d 169.254.0.0/16 -j DROP
iptables -A HACK-BUILD-INPUT -j DROP
iptables -C DOCKER-USER -i docker0 -j HACK-BUILD-FORWARD 2>/dev/null ||
  iptables -I DOCKER-USER 1 -i docker0 -j HACK-BUILD-FORWARD
iptables -C INPUT -i docker0 -j HACK-BUILD-INPUT 2>/dev/null ||
  iptables -I INPUT 1 -i docker0 -j HACK-BUILD-INPUT
printf 'build-network-v1 %s\n' "$2" > "$marker.pending"
mv "$marker.pending" "$marker"
