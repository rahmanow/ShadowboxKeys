#!/bin/bash
dockerd >/var/log/dockerd.log 2>&1 &
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 && echo "dockerd ready" || echo "dockerd FAILED"
exec /usr/sbin/sshd -D -e
