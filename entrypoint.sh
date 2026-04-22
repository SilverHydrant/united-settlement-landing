#!/bin/sh
# Container entrypoint — runs as root, fixes volume ownership, then drops
# to the non-root app user.
#
# Why this exists: Railway mounts the persistent volume at /data at RUNTIME,
# which overwrites the image's /data directory. Whatever `chown` we did
# during `docker build` is wiped out. The mount shows up owned by root,
# and since we run the app as `pwuser`, every write to /data fails with
# EACCES. This script is the earliest point at which we can see the real
# (mounted) /data and fix its ownership.
set -e

if [ -d /data ]; then
  chown pwuser:pwuser /data || true
  chmod 755 /data || true
fi

# Drop root for the actual app. Using `gosu` (installed in the Dockerfile)
# because it exec()s directly — no intermediate shell, signals propagate,
# pid 1 is the Node process so Railway's SIGTERM on redeploy works.
exec gosu pwuser "$@"
