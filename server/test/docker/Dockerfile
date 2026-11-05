# Тестовая «VPS» для real-*.test.ts: Docker-in-Docker с SSH (root / rootpass123).
# Собрать и запустить две ноды: ./nodes.sh up
FROM docker:dind

# DinD уже содержит SSH-клиент. Для тестовой ноды нужны только sshd и его зависимости.
RUN apk add --no-cache bash openssh-server shadow coreutils iptables iproute2 procps curl \
    && ssh-keygen -A \
    && echo 'root:rootpass123' | chpasswd \
    && echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config \
    && echo 'PasswordAuthentication yes' >> /etc/ssh/sshd_config

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 22
ENTRYPOINT ["/entrypoint.sh"]
CMD []
