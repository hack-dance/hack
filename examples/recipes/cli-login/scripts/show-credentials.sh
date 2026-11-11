#!/bin/sh
# Stand-in application: report which credentials it received, never the values.
if [ -n "${DEPLOY_TOKEN:-}" ]; then
  echo "deploy token: present (${#DEPLOY_TOKEN} characters)"
else
  echo "deploy token: missing"
fi
if [ -s "$EDGE_API_TOKEN_FILE" ]; then
  echo "edge token file: present"
else
  echo "edge token file: missing"
fi
exec sleep infinity
