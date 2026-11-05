# A throwaway "VPS" for Docksy end-to-end tests: Debian with systemd as PID 1,
# OpenSSH (root login by key only) and Docker-in-Docker.
#
#   docker build -t docksy-fake-vps e2e/fake-vps
#   docker run -d --name vps --privileged --cgroupns=host \
#     -v /sys/fs/cgroup:/sys/fs/cgroup:rw --tmpfs /run --tmpfs /run/lock \
#     -e SSH_AUTHORIZED_KEYS="ssh-ed25519 AAAA… docksy" -p 2222:22 docksy-fake-vps
#
# Docker is preinstalled (provision.sh then just verifies it) so tests do not
# depend on get.docker.com. Build with --build-arg PREINSTALL_DOCKER=0 to test
# the installer path too.
FROM debian:trixie

ARG PREINSTALL_DOCKER=1
ENV container=docker DEBIAN_FRONTEND=noninteractive LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus openssh-server ca-certificates curl git iproute2 procps sudo util-linux gnupg \
 && if [ "$PREINSTALL_DOCKER" = 1 ]; then \
      install -m 0755 -d /etc/apt/keyrings \
   && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
   && . /etc/os-release \
   && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list \
   && apt-get update \
   && apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; \
    fi \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Trim units that make no sense in a container; keep ssh + docker.
RUN systemctl mask getty.target console-getty.service systemd-firstboot.service systemd-udevd.service \
      systemd-udev-trigger.service systemd-modules-load.service sys-kernel-config.mount 2>/dev/null || true \
 && systemctl enable ssh.service \
 && if [ -e /lib/systemd/system/docker.service ]; then systemctl enable docker.service containerd.service; fi

# sshd: root by key only, no passwords anywhere.
RUN mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh \
 && printf '%s\n' \
      'PermitRootLogin prohibit-password' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PubkeyAuthentication yes' \
      'UseDNS no' \
      > /etc/ssh/sshd_config.d/10-docksy-e2e.conf \
 && passwd -l root

# Inject SSH_AUTHORIZED_KEYS from the container env on every boot (before sshd starts).
COPY authorized-keys.sh /usr/local/sbin/docksy-e2e-authorized-keys
COPY authorized-keys.service /etc/systemd/system/docksy-e2e-authorized-keys.service
RUN chmod 0755 /usr/local/sbin/docksy-e2e-authorized-keys \
 && systemctl enable docksy-e2e-authorized-keys.service

# Inner Docker/containerd need a real (non-overlay) filesystem for their overlay
# snapshots. Docker 29+ keeps images in containerd's store, so both are volumes.
VOLUME ["/var/lib/docker", "/var/lib/containerd"]
EXPOSE 22 80 443
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
