#!/usr/bin/env bash
# 在中转 VPS 上一键部署 coturn 并接入中转（幂等，可重复执行）。
#   sudo bash setup-turn.sh [公网 IP 或域名]
# 不传参数时自动探测公网 IP。已有密钥会复用，不会因为重跑而让设备手里的凭据失效。
# 密钥只写入 /etc/turnserver.conf 与 /etc/u-brain-relay.env（0600），不会打印。
set -euo pipefail

ENV_FILE=${RELAY_ENV_FILE:-/etc/u-brain-relay.env}
CONF=/etc/turnserver.conf
SERVICE=${RELAY_SERVICE:-u-brain-relay}
PORT=3478

[ "$(id -u)" -eq 0 ] || { echo "需要 root 运行" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "找不到 $ENV_FILE，请先部署中转" >&2; exit 1; }

HOST=${1:-}
if [ -z "$HOST" ]; then
  HOST=$(curl -fsS --max-time 8 https://api.ipify.org || curl -fsS --max-time 8 https://ifconfig.me || true)
fi
[ -n "$HOST" ] || { echo "探测不到公网 IP，请作为参数传入" >&2; exit 1; }

get_env() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
set_env() {
  local key=$1 val=$2
  if grep -q "^$key=" "$ENV_FILE"; then
    sed -i "s|^$key=.*|$key=$val|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

echo "[1/5] 安装 coturn"
if ! command -v turnserver >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq coturn
fi

echo "[2/5] 准备共享密钥"
SECRET=$(get_env RELAY_TURN_SECRET)
if [ ${#SECRET} -lt 32 ]; then
  SECRET=$(openssl rand -hex 32)
fi

echo "[3/5] 写 coturn 配置"
# 公网 IP 不在本机网卡上（NAT 型 VPS）时才需要 external-ip
EXTERNAL_LINE=""
if [[ "$HOST" =~ ^[0-9.]+$ ]] && ! ip -o addr show | grep -q " $HOST/"; then
  EXTERNAL_LINE="external-ip=$HOST"
fi
[ -f "$CONF" ] && cp -p "$CONF" "$CONF.bak-$(date +%Y%m%d%H%M%S)"
umask 077
cat > "$CONF" <<EOF
# 由 services/telegram-relay/deploy/setup-turn.sh 生成，重跑会覆盖
listening-port=$PORT
fingerprint
use-auth-secret
static-auth-secret=$SECRET
realm=$HOST
$EXTERNAL_LINE
min-port=49152
max-port=65535
total-quota=100
bps-capacity=0
stale-nonce=600
no-multicast-peers
no-cli
no-loopback-peers

# 禁止通过 TURN 中继探测 VPS 本机回环与内网网段
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=::1
denied-peer-ip=fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff
denied-peer-ip=fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff
EOF
chown root:turnserver "$CONF" 2>/dev/null || true
chmod 0640 "$CONF"
# Debian/Ubuntu 老版本需要显式启用
if [ -f /etc/default/coturn ]; then
  sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
fi

echo "[4/5] 写中转环境变量并重启服务"
cp -p "$ENV_FILE" "$ENV_FILE.bak-turn-$(date +%Y%m%d%H%M%S)"
set_env RELAY_TURN_URLS "turn:$HOST:$PORT?transport=udp,turn:$HOST:$PORT?transport=tcp"
set_env RELAY_TURN_SECRET "$SECRET"
systemctl enable coturn >/dev/null 2>&1 || true
systemctl restart coturn
systemctl restart "$SERVICE"

echo "[5/5] 自检"
sleep 2
systemctl is-active --quiet coturn || { echo "coturn 未运行" >&2; journalctl -u coturn -n 20 --no-pager >&2; exit 1; }
systemctl is-active --quiet "$SERVICE" || { echo "$SERVICE 未运行" >&2; exit 1; }
ss -lnuH "sport = :$PORT" | grep -q . || { echo "UDP $PORT 未监听" >&2; exit 1; }
ss -lntH "sport = :$PORT" | grep -q . || { echo "TCP $PORT 未监听" >&2; exit 1; }

# 用与中转相同的算法签一个临时凭据，向本机 coturn 申请一次中继地址
if command -v turnutils_uclient >/dev/null 2>&1; then
  USER="$(($(date +%s) + 600)):selftest"
  PASS=$(printf '%s' "$USER" | openssl dgst -sha1 -hmac "$SECRET" -binary | base64)
  OUT=$(timeout 15 turnutils_uclient -u "$USER" -w "$PASS" -y -n 1 -m 1 -e 8.8.8.8 -p "$PORT" 127.0.0.1 2>&1 || true)
  # 走到 channel bind 说明认证与 Allocation 已通过（被 denied-peer-ip 拒掉的 403 是预期的防护）
  if echo "$OUT" | grep -qiE "channel bind|relay" && ! echo "$OUT" | grep -qE "error 401|Unauthorized"; then
    echo "凭据自检通过：coturn 已接受中转算法签发的临时凭据"
  else
    echo "警告：凭据自检未通过，请手动核对（turnutils_uclient 输出如下）" >&2
    echo "$OUT" | tail -8 >&2
  fi
fi

echo "完成。TURN 地址：$HOST:$PORT（udp/tcp），中继端口 49152-65535/udp 需在云厂商防火墙放行。"
