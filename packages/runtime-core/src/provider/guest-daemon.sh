set -eu
exec dockerd --storage-driver=overlay2 --data-root=/var/lib/docker \
  --bridge=none --iptables=false --ip6tables=false --ip-forward=false --ip-masq=false \
  --exec-root=/run/hack-local/exec --pidfile=/run/hack-local/docker.pid \
  --host=unix:///run/hack-local/docker.sock --log-level=warn \
  >/storage/hack-local-dockerd.log 2>&1
