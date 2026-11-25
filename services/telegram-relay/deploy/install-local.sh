#!/usr/bin/env bash
# 在中转 VPS 本机执行（root），幂等完成：
#   1. 准备 u-brain-relay 系统用户与可被 ProtectHome=true 访问的 /usr/local/bin/bun
#   2. 同步中转源码与部署脚本到 /opt/u-brain-relay
#   3. 首次生成 /etc/u-brain-relay.env；若已有旧 BOT_TOKEN，默认自动调 deleteWebhook 并清空为纯设备中枢模式
#   4. 安装/更新 u-brain-relay.service
#   5. 部署/检查 coturn（支持 --skip-turn / --auto-turn / --turn-host）并重启中转
#   6. 自检本机 /check 端点
#
# 既可由 deploy.sh 远程触发，也可在 VPS 本机（或服务器安装包 install.sh 内）直接调用。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -d "$HERE/src" ]; then
  SRC_DIR="$HERE/src"
elif [ -d "$HERE/../src" ]; then
  SRC_DIR=$(cd "$HERE/../src" && pwd)
else
  echo "找不到中转 src 目录（已检查 $HERE/src 与 $HERE/../src）" >&2
  exit 1
fi

TURN_MODE="always" # always | auto | skip
TURN_HOST=""
KEEP_BOT_TOKEN=${KEEP_BOT_TOKEN:-0}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-turn) TURN_MODE="skip"; shift ;;
    --auto-turn) TURN_MODE="auto"; shift ;;
    --turn-host) TURN_HOST=${2:-}; shift 2 ;;
    --keep-bot-token) KEEP_BOT_TOKEN=1; shift ;;
    *) echo "install-local.sh: 未知参数 $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "install-local.sh 需要 root 权限" >&2; exit 1; }

echo "==> [relay] 准备运行用户、bun 与目录"
id u-brain-relay >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/u-brain-relay --shell /usr/sbin/nologin u-brain-relay

export PATH="/usr/local/bin:$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  command -v npm >/dev/null 2>&1 || { echo "VPS 上没有 bun 也没有 npm，请先安装 bun" >&2; exit 1; }
  npm i -g bun --registry=https://registry.npmmirror.com >/dev/null
fi

real=$(readlink -f "$(command -v bun)")
[ -x "$real" ] || { echo "解析不到可执行的 bun：$real" >&2; exit 1; }
case "$real" in
  /root/*|/home/*)
    # 服务开启了 ProtectHome=true，位于家目录的 bun 需拷贝一份独立二进制到 /usr/local/bin/bun
    rm -f /usr/local/bin/bun
    install -m 0755 "$real" /usr/local/bin/bun
    ;;
  *)
    [ "$real" = /usr/local/bin/bun ] || ln -sfn "$real" /usr/local/bin/bun
    ;;
esac

su -s /bin/sh u-brain-relay -c '/usr/local/bin/bun --version' >/dev/null 2>&1 || {
  echo "u-brain-relay 用户无法执行 /usr/local/bin/bun" >&2
  exit 1
}

mkdir -p /opt/u-brain-relay
target_src=$(readlink -f /opt/u-brain-relay/src 2>/dev/null || printf '%s' "")
from_src=$(readlink -f "$SRC_DIR")
if [ "$from_src" != "$target_src" ]; then
  rm -rf /opt/u-brain-relay/src.next
  cp -R "$SRC_DIR" /opt/u-brain-relay/src.next
  rm -rf /opt/u-brain-relay/src
  mv /opt/u-brain-relay/src.next /opt/u-brain-relay/src
fi

for f in u-brain-relay.service u-brain-relay.env.example setup-turn.sh install-local.sh; do
  if [ -f "$HERE/$f" ]; then
    src_f=$(readlink -f "$HERE/$f")
    dst_f=$(readlink -f "/opt/u-brain-relay/$f" 2>/dev/null || printf '%s' "")
    if [ "$src_f" != "$dst_f" ]; then
      cp -f "$HERE/$f" "/opt/u-brain-relay/$f"
    fi
  fi
done
chmod 0755 /opt/u-brain-relay/setup-turn.sh /opt/u-brain-relay/install-local.sh 2>/dev/null || true

echo "==> [relay] 检查环境文件与 systemd 单元"
ENV_FILE=/etc/u-brain-relay.env
if [ ! -f "$ENV_FILE" ]; then
  install -m 0600 -o root -g u-brain-relay /opt/u-brain-relay/u-brain-relay.env.example "$ENV_FILE"
  key=$(openssl rand -hex 24)
  sed -i "s|^RELAY_KEY=.*|RELAY_KEY=$key|" "$ENV_FILE"
  echo "已生成 $ENV_FILE（纯设备中枢模式）"
fi
chown root:u-brain-relay "$ENV_FILE" 2>/dev/null || true
chmod 0600 "$ENV_FILE"

if [ "$KEEP_BOT_TOKEN" != "1" ]; then
  old_bot_token=$(sed -n 's/^BOT_TOKEN=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')
  if [ -n "$old_bot_token" ]; then
    cp -p "$ENV_FILE" "$ENV_FILE.bak-notg-$(date +%Y%m%d%H%M%S)"
    # 经 stdin 调用 deleteWebhook 注销旧 Telegram 推送，避免 Token 出现在命令行参数中；网络不通也不阻断部署
    printf 'url = "https://api.telegram.org/bot%s/deleteWebhook"\n' "$old_bot_token" \
      | curl -fsS --max-time 6 -K - >/dev/null 2>&1 || true
    sed -i 's|^BOT_TOKEN=.*|BOT_TOKEN=|' "$ENV_FILE"
    echo "已自动注销旧 Telegram Webhook 并清空 $ENV_FILE 中的 BOT_TOKEN（原配置已备份）"
  fi
fi

if ! cmp -s /opt/u-brain-relay/u-brain-relay.service /etc/systemd/system/u-brain-relay.service; then
  cp /opt/u-brain-relay/u-brain-relay.service /etc/systemd/system/u-brain-relay.service
  systemctl daemon-reload
fi
systemctl enable u-brain-relay >/dev/null 2>&1 || true

need_turn=0
case "$TURN_MODE" in
  always) need_turn=1 ;;
  auto)
    turn_urls=$(sed -n 's/^RELAY_TURN_URLS=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')
    turn_secret=$(sed -n 's/^RELAY_TURN_SECRET=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')
    if [ -z "$turn_urls" ] || [ -z "$turn_secret" ] || ! systemctl is-active --quiet coturn 2>/dev/null; then
      need_turn=1
    fi
    ;;
  skip) need_turn=0 ;;
esac

if [ "$need_turn" -eq 1 ]; then
  echo "==> [relay] 部署 coturn 并重启中转"
  if [ -n "$TURN_HOST" ]; then
    bash /opt/u-brain-relay/setup-turn.sh "$TURN_HOST"
  else
    bash /opt/u-brain-relay/setup-turn.sh
  fi
else
  echo "==> [relay] 重启 u-brain-relay"
  systemctl restart u-brain-relay
fi

echo "==> [relay] 自检"
sleep 2
systemctl is-active --quiet u-brain-relay || {
  echo "u-brain-relay 未运行" >&2
  journalctl -u u-brain-relay -n 20 --no-pager >&2
  exit 1
}
port=$(sed -n 's/^RELAY_PORT=//p' "$ENV_FILE" | tail -n 1 | tr -d '[:space:]')
port=${port:-8787}
key=$(sed -n 's/^RELAY_KEY=//p' "$ENV_FILE" | tail -n 1 | tr -d '\r')
code=$(printf 'header = "Authorization: Bearer %s"\nurl = "http://127.0.0.1:%s/check"\n' "$key" "$port" \
  | curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 -K - || true)
case "$code" in
  200) echo "中转 /check 正常（200）" ;;
  401|403) echo "中转在运行，/check 返回 $code（已关闭共享密钥时属正常）" ;;
  *) echo "中转 /check 异常，HTTP $code" >&2; exit 1 ;;
esac
