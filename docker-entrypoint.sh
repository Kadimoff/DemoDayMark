#!/bin/sh
# The ./data bind mount is usually created by Docker as root: hand it to the
# unprivileged "node" user, then drop privileges before starting the app.
set -e
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
