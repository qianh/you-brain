#!/usr/bin/env bash
# 在本机执行，把中转一键部署（或升级）到自有 VPS，幂等，可重复运行。
#
#   services/telegram-relay/deploy/deploy.sh [选项]
#
# 连接信息（按优先级）：
#   --target user@host / --port N，或环境变量 RELAY_SSH_TARGET / RELAY_SSH_PORT，
#   或仓库根 .env 里的 Address / SSH_Port（用户固定 root）。
#
# 选项：
#   --dry-run     只显示将同步的文件差异，不改动 VPS
#   --skip-turn   不部署/更新 coturn（默认会部署，见 setup-turn.sh）
#   --skip-test   不先跑本地测试
#   --turn-host H TURN 对外地址（公网 IP 或域名），默认由 VPS 自动探测
#
# 做的事：本地测试 → 同步 src → 建运行用户与目录 → 首次部署时生成环境文件（已有则不碰）
#        → 安装/更新 systemd 单元 → coturn → 重启 → 自检。
# 不做的事：Bot Token（首次部署后需手工填）、Caddy / cloudflared 反代、Telegram webhook。
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELAY_DIR=$(cd "$HERE/.." && pwd)
REPO_ROOT=$(cd "$RELAY_DIR/../.." && pwd)

export PATH="$HOME/.bun/bin:$PATH"
TARGET=${RELAY_SSH_TARGET:-}
PORT=${RELAY_SSH_PORT:-}
DRY_RUN=0; SKIP_TURN=0; SKIP_TEST=0; TURN_HOST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-turn) SKIP_TURN=1; shift ;;
    --skip-test) SKIP_TEST=1; shift ;;
    --turn-host) TURN_HOST=$2; shift 2 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# 从 .env 取连接信息：只取这两个键，不读其他内容
if [ -z "$TARGET" ] && [ -f "$REPO_ROOT/.env" ]; then
  addr=$(sed -n 's/^Address: *//p' "$REPO_ROOT/.env" | head -n 1)
  [ -n "$addr" ] && TARGET="root@$addr"
  [ -z "$PORT" ] && PORT=$(sed -n 's/^SSH_Port: *//p' "$REPO_ROOT/.env" | head -n 1)
fi
[ -n "$TARGET" ] || { echo "缺少 VPS 地址：用 --target user@host 或设置 RELAY_SSH_TARGET" >&2; exit 2; }
PORT=${PORT:-22}

SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=15 -p "$PORT")
RSYNC_SSH="ssh -o BatchMode=yes -o ConnectTimeout=15 -p $PORT"
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }

echo "==> 目标 $TARGET:$PORT"
remote 'test "$(id -u)" -eq 0' || { echo "目标用户必须是 root（要写 /etc 与 systemd）" >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "==> [dry-run] src 同步差异（空表示一致）"
  rsync -rcn --delete --itemize-changes -e "$RSYNC_SSH" "$RELAY_DIR/src/" "$TARGET:/opt/u-brain-relay/src/" || true
  echo "==> [dry-run] systemd 单元"
  if remote 'cat /etc/systemd/system/u-brain-relay.service 2>/dev/null' | diff -q - "$HERE/u-brain-relay.service" >/dev/null; then
    echo "一致"
  else
    echo "有差异，实际部署时会更新并重启"
  fi
  exit 0
fi

if [ "$SKIP_TEST" -eq 0 ]; then
  command -v bun >/dev/null 2>&1 || { echo "本机没有 bun，无法跑本地测试（可加 --skip-test）" >&2; exit 1; }
  echo "==> 本地测试"
  (cd "$REPO_ROOT" && bun test services/telegram-relay)
fi

echo "==> 准备 VPS 环境（bun、运行用户、目录）"
remote 'bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v bun >/dev/null 2>&1; then
  command -v npm >/dev/null 2>&1 || { echo "VPS 上没有 bun 也没有 npm，请先安装 bun" >&2; exit 1; }
  npm i -g bun --registry=https://registry.npmmirror.com >/dev/null
fi
# 用 readlink -f 解析到真实文件：直接 command -v 可能就是 /usr/local/bin/bun 自己，ln -sfn 会把它改成自指的死链接
real=$(readlink -f "$(command -v bun)")
[ -x "$real" ] || { echo "解析不到可执行的 bun：$real" >&2; exit 1; }
[ "$real" = /usr/local/bin/bun ] || ln -sfn "$real" /usr/local/bin/bun
# 服务以 u-brain-relay 运行且 ProtectHome=true，bun 不能放在 /root 或 /home 下
case "$real" in /root/*|/home/*) echo "bun 在 $real，服务用户访问不到，请装到 /usr 下（npm i -g bun）" >&2; exit 1 ;; esac
sudo -u u-brain-relay /usr/local/bin/bun --version >/dev/null 2>&1 || { echo "u-brain-relay 用户无法执行 /usr/local/bin/bun" >&2; exit 1; }
id u-brain-relay >/dev/null 2>&1 || useradd --system --user-group --home-dir /var/lib/u-brain-relay --shell /usr/sbin/nologin u-brain-relay
mkdir -p /opt/u-brain-relay/src
REMOTE

echo "==> 同步 src"
rsync -rc --delete -e "$RSYNC_SSH" "$RELAY_DIR/src/" "$TARGET:/opt/u-brain-relay/src/"
rsync -c -e "$RSYNC_SSH" "$HERE/u-brain-relay.service" "$HERE/u-brain-relay.env.example" "$HERE/setup-turn.sh" "$TARGET:/opt/u-brain-relay/"

echo "==> 环境文件与 systemd 单元"
FIRST_RUN=$(remote 'bash -s' <<'REMOTE'
set -euo pipefail
first=0
if [ ! -f /etc/u-brain-relay.env ]; then
  first=1
  install -m 0600 -o root -g u-brain-relay /opt/u-brain-relay/u-brain-relay.env.example /etc/u-brain-relay.env
  key=$(openssl rand -hex 24)
  sed -i "s|^RELAY_KEY=.*|RELAY_KEY=$key|" /etc/u-brain-relay.env
fi
if ! cmp -s /opt/u-brain-relay/u-brain-relay.service /etc/systemd/system/u-brain-relay.service; then
  cp /opt/u-brain-relay/u-brain-relay.service /etc/systemd/system/u-brain-relay.service
  systemctl daemon-reload
fi
systemctl enable u-brain-relay >/dev/null 2>&1
echo "$first"
REMOTE
)

if [ "$SKIP_TURN" -eq 0 ]; then
  echo "==> 部署 coturn 并接入中转（会重启中转）"
  remote "bash /opt/u-brain-relay/setup-turn.sh $TURN_HOST"
else
  echo "==> 重启中转"
  remote 'systemctl restart u-brain-relay'
fi

echo "==> 自检"
remote 'bash -s' <<'REMOTE'
set -euo pipefail
sleep 2
systemctl is-active --quiet u-brain-relay || { echo "u-brain-relay 未运行" >&2; journalctl -u u-brain-relay -n 20 --no-pager >&2; exit 1; }
port=$(sed -n 's/^RELAY_PORT=//p' /etc/u-brain-relay.env | tail -n 1); port=${port:-8787}
key=$(sed -n 's/^RELAY_KEY=//p' /etc/u-brain-relay.env | tail -n 1)
# 密钥经 stdin 交给 curl，不出现在命令行参数里
code=$(printf 'header = "Authorization: Bearer %s"\nurl = "http://127.0.0.1:%s/check"\n' "$key" "$port" \
  | curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 8 -K - || true)
case "$code" in
  200) echo "中转 /check 正常（200）" ;;
  401|403) echo "中转在运行，/check 返回 $code（已关闭共享密钥时属正常）" ;;
  *) echo "中转 /check 异常，HTTP $code" >&2; exit 1 ;;
esac
REMOTE

if [ "$FIRST_RUN" = "1" ]; then
  cat <<'EOF'

!! 这是首次部署：/etc/u-brain-relay.env 里已生成 RELAY_KEY，但 BOT_TOKEN 为空。
   请在 VPS 上编辑该文件填入 BOT_TOKEN 后 systemctl restart u-brain-relay；
   并按 README 配好 Caddy 或 cloudflared 反代，再设置 RELAY_PUBLIC_ORIGIN（经隧道时必填）。
EOF
fi
echo "完成。"
