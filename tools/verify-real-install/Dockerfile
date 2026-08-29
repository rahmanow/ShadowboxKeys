# A stand-in for a fresh VPS: Debian, sshd, and a working Docker daemon, which
# is what the real Outline installer needs and what a provider image gives you.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssh-server sudo curl ca-certificates iproute2 docker.io \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && echo 'root:vpstestpassword' | chpasswd \
 && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
COPY start.sh /start.sh
RUN chmod +x /start.sh
CMD ["/start.sh"]
