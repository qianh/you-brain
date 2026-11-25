#!/usr/bin/env bash
# 把中转一键部署（或升级）到自有 VPS，幂等，可重复运行。
# 支持从开发机经 SSH 推送部署，也支持在 VPS 本机拉取代码后直接执行（--local 或自动识别）。
#
#   services/telegram-relay/deploy/deploy.sh [选项]
#
# 连接信息（按优先级）：
#   --local（或在 Linux VPS 本机检测到 /etc/u-brain-relay.env 且未指定远端时自动启用本机模式）
#   --target user@host / --port N，或环境变量 RELAY_SSH_TARGET / RELAY_SSH_PORT，
#   或仓库根 .env 里的 Address / SSH_Port（用户固定 root）。
#
# 选项：
#   --local           直接在当前 Linux 服务器本机安装/升级中转（不走 SSH）
#   --dry-run         只显示将同步的文件差异，不改动 VPS
#   --skip-turn       不部署/更新 coturn（默认会部署，见 setup-turn.sh）
#   --skip-test       不先跑本地测试
#   --turn-host H     TURN 对外地址（公网 IP 或域名），默认由 VPS 自动探测
#   --keep-bot-token  保留已有的 BOT_TOKEN（默认会自动注销旧 Telegram Webhook 并清空 BOT_TOKEN，切为纯设备中枢模式）
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELAY_DIR=$(cd "$HERE/.." && pwd)
REPO_ROOT=$(cd "$RELAY_DIR/../.." && pwd)

export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"
TARGET=${RELAY_SSH_TARGET:-}
PORT=${RELAY_SSH_PORT:-}
LOCAL_MODE=0; DRY_RUN=0; SKIP_TURN=0; SKIP_TEST=0; TURN_HOST=""; KEEP_BOT_TOKEN=${KEEP_BOT_TOKEN:-0}

while [ $# -gt 0 ]; do
  case "$1" in
    --local) LOCAL_MODE=1; shift ;;
    --target) TARGET=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-turn) SKIP_TURN=1; shift ;;
    --skip-test) SKIP_TEST=1; shift ;;
    --turn-host) TURN_HOST=$2; shift 2 ;;
    --keep-bot-token) KEEP_BOT_TOKEN=1; shift ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

# 从 .env 取连接信息：只取这两个键，不读其他内容
if [ "$LOCAL_MODE" -eq 0 ] && [ -z "$TARGET" ] && [ -f "$REPO_ROOT/.env" ]; then
  addr=$(sed -n 's/^Address: *//p' "$REPO_ROOT/.env" | head -n 1)
  [ -n "$addr" ] && TARGET="root@$addr"
  [ -z "$PORT" ] && PORT=$(sed -n 's/^SSH_Port: *//p' "$REPO_ROOT/.env" | head -n 1)
fi

# 在 Linux VPS 本机拉代码直接执行时自动走本机模式
if [ "$LOCAL_MODE" -eq 0 ] && [ -z "$TARGET" ] && [ "$(uname -s 2>/dev/null || true)" = "Linux" ]; then
  if [ -f /etc/u-brain-relay.env ] || [ -d /opt/u-brain-relay ] || [ -f /etc/systemd/system/u-brain-relay.service ]; then
    LOCAL_MODE=1
  fi
fi

INSTALL_ARGS=()
[ "$SKIP_TURN" -eq 1 ] && INSTALL_ARGS+=(--skip-turn)
[ -n "$TURN_HOST" ] && INSTALL_ARGS+=(--turn-host "$TURN_HOST")
[ "$KEEP_BOT_TOKEN" = "1" ] && INSTALL_ARGS+=(--keep-bot-token)

if [ "$LOCAL_MODE" -eq 1 ]; then
  echo "==> 本机模式部署中转"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "==> [dry-run] 本机 /opt/u-brain-relay/src 差异"
    diff -ru "$RELAY_DIR/src" /opt/u-brain-relay/src || true
    exit 0
  fi
  if [ "$SKIP_TEST" -eq 0 ] && command -v bun >/dev/null 2>&1; then
    echo "==> 本地测试"
    (cd "$REPO_ROOT" && bun test services/telegram-relay)
  fi
  if [ "$(id -u)" -eq 0 ]; then
    bash "$HERE/install-local.sh" "${INSTALL_ARGS[@]}"
  else
    sudo bash "$HERE/install-local.sh" "${INSTALL_ARGS[@]}"
  fi
  echo "完成。"
  exit 0
fi

[ -n "$TARGET" ] || { echo "缺少 VPS 地址：用 --target user@host、设置 RELAY_SSH_TARGET，或在 VPS 本机加 --local" >&2; exit 2; }
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

echo "==> 同步中转源码与安装脚本到 VPS"
remote 'mkdir -p /opt/u-brain-relay/src'
rsync -rc --delete -e "$RSYNC_SSH" "$RELAY_DIR/src/" "$TARGET:/opt/u-brain-relay/src/"
rsync -c -e "$RSYNC_SSH" \
  "$HERE/u-brain-relay.service" \
  "$HERE/u-brain-relay.env.example" \
  "$HERE/setup-turn.sh" \
  "$HERE/install-local.sh" \
  "$TARGET:/opt/u-brain-relay/"

echo "==> 执行远端自动安装与配置迁移"
remote "bash /opt/u-brain-relay/install-local.sh ${INSTALL_ARGS[*]:-}"

echo "完成。"
