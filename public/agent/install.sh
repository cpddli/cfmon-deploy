#!/bin/sh
# cfmon agent 一键安装脚本（Linux，需要 root）
#
#   curl -fsSL https://你的面板/agent/install.sh | sudo sh -s -- --url https://你的面板 --token 密钥
#
# 默认安装零依赖的 shell 版本（只需要 sh + coreutils，不需要 python3）。
# 想用 Python 版本加 --agent py。
#
set -eu

BASE_URL=""
TOKEN=""
INTERVAL="30"
DISK="/"
AGENT_KIND="sh"
UNINSTALL="0"

SERVICE="cfmon-agent"
BIN="/usr/local/bin/cfmon-agent"
CONF_DIR="/etc/cfmon"
CONF="$CONF_DIR/agent.conf"
UNIT="/etc/systemd/system/$SERVICE.service"

say()  { printf '\033[36m[cfmon]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[cfmon]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[cfmon] 错误：\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  curl -fsSL https://面板地址/agent/install.sh | sudo sh -s -- --url https://面板地址 --token 密钥

参数：
  --url URL        面板地址（必填）
  --token TOKEN    这台服务器的密钥（必填）
  --interval N     上报间隔秒数，默认 30（最小 5）
  --disk LIST      要统计的挂载点，逗号分隔，默认 /
  --agent sh|py    采集端实现，默认 sh（零依赖，无需 python3）
  --uninstall      卸载 agent
  -h, --help       显示帮助
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)       BASE_URL="${2:-}"; shift 2 ;;
    --token)     TOKEN="${2:-}"; shift 2 ;;
    --interval)  INTERVAL="${2:-}"; shift 2 ;;
    --disk)      DISK="${2:-}"; shift 2 ;;
    --agent)     AGENT_KIND="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL="1"; shift ;;
    -h|--help)   usage; exit 0 ;;
    *)           die "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

[ "$(id -u)" = "0" ] || die "请用 root 运行（curl … | sudo sh -s -- …）"

# ---------------------------------------------------------------- 卸载分支
if [ "$UNINSTALL" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
    rm -f "$UNIT"
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  pkill -f "$BIN" >/dev/null 2>&1 || true
  rm -f "$BIN" "$CONF"
  rmdir "$CONF_DIR" >/dev/null 2>&1 || true
  say "已卸载 cfmon agent"
  exit 0
fi

[ -n "$BASE_URL" ] || die "缺少 --url（用 --help 查看用法）"
[ -n "$TOKEN" ]    || die "缺少 --token（用 --help 查看用法）"
BASE_URL="$(printf '%s' "$BASE_URL" | sed 's:/*$::')"
case "$BASE_URL" in
  http://*|https://*) : ;;
  *) die "--url 必须以 http:// 或 https:// 开头" ;;
esac

# ---------------------------------------------------------------- 选采集端
case "$AGENT_KIND" in
  sh) AGENT_FILE="cfmon-agent.sh";     AGENT_MARK="#!/bin/sh" ;;
  py) AGENT_FILE="cfmon-agent.py";     AGENT_MARK="python" ;;
  *)  die "--agent 只能是 sh 或 py" ;;
esac

# 上报和下载都需要 curl 或 wget 之一
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "需要 curl 或 wget 之一（上报指标要用）。
  Debian/Ubuntu: apt-get install -y curl ca-certificates
  CentOS/RHEL:   yum install -y curl ca-certificates
  Alpine:        apk add curl ca-certificates"
fi

if [ "$AGENT_KIND" = "py" ] && ! command -v python3 >/dev/null 2>&1; then
  die "选择 python 版但本机没有 python3。去掉 --agent py 即可用零依赖的 shell 版本。"
fi

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 30 "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" --timeout=30 "$1"
  else
    return 1
  fi
}

# ---------------------------------------------------------------- 安装文件
say "从 $BASE_URL 下载 $AGENT_FILE …"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT INT TERM
fetch "$BASE_URL/agent/$AGENT_FILE" "$tmp" || die "下载失败，请确认面板地址可访问、Worker 已部署"

head -n 1 "$tmp" | grep -q "$AGENT_MARK" || die "下载到的内容不是 agent 脚本，请检查 $BASE_URL/agent/$AGENT_FILE"

if command -v install >/dev/null 2>&1; then
  install -m 0755 "$tmp" "$BIN" || die "无法写入 $BIN"
else
  cp "$tmp" "$BIN" && chmod 0755 "$BIN" || die "无法写入 $BIN"
fi

mkdir -p "$CONF_DIR"
umask 077
cat > "$CONF" <<EOF
CFMON_URL=$BASE_URL
CFMON_TOKEN=$TOKEN
CFMON_INTERVAL=$INTERVAL
CFMON_DISK=$DISK
EOF
chmod 600 "$CONF"
say "已写入 $BIN 和 $CONF（权限 600，密钥不会出现在进程参数里）"

# ---------------------------------------------------------------- 自检上报
say "自检：先上报一次…"
if "$BIN" --once; then
  say "自检通过，面板上应该已经能看到这台机器了"
else
  die "自检失败。常见原因：密钥填错 / 面板地址不可达 / 服务器时间偏差过大。
  可手动重试：$BIN --once
  看详细输出：$BIN --once --verbose
  改配置后重装即可：本脚本可重复执行"
fi

# ---------------------------------------------------------------- 守护进程
if ! command -v systemctl >/dev/null 2>&1; then
  warn "没有 systemd，改用 nohup 后台运行（重启后不会自动拉起）"
  pkill -f "$BIN" >/dev/null 2>&1 || true
  nohup "$BIN" >>/var/log/cfmon-agent.log 2>&1 &
  say "已启动（PID $!），日志：/var/log/cfmon-agent.log"
  exit 0
fi

cat > "$UNIT" <<EOF
[Unit]
Description=cfmon agent (server metrics reporter)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$CONF
ExecStart=$BIN
Restart=always
RestartSec=10
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1 || true
systemctl restart "$SERVICE"

sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  say "服务已启动：systemctl status $SERVICE"
  say "查看日志：journalctl -u $SERVICE -f"
else
  warn "服务启动失败，最近日志："
  journalctl -u "$SERVICE" -n 20 --no-pager || true
  exit 1
fi
