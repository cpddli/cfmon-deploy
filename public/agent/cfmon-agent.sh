#!/bin/sh
# cfmon-agent —— 零依赖服务器采集端
#
# 只需要 Linux 自带的 sh + coreutils/busybox + curl（或 wget），
# 不需要 python、不需要编译、不需要装任何东西，脚本本身 12 KB。
#
# 用法：
#   cfmon-agent                              读 /etc/cfmon/agent.conf
#   cfmon-agent --url https://面板 --token x  手动指定
#   cfmon-agent --once                       只上报一次
#   cfmon-agent --dry-run --once             只打印 JSON，不上报（排查用）
#
# 调试用环境变量：CFMON_PROC 可指向假的 /proc 目录。

set -eu

VERSION="1.1.0"
CONF_FILE="${CFMON_CONF:-/etc/cfmon/agent.conf}"
PROC="${CFMON_PROC:-/proc}"
SAMPLE_WAIT="${CFMON_SAMPLE_WAIT:-1}"

URL=""
TOKEN=""
INTERVAL=""
DISK_MOUNTS=""
ONCE=0
DRY=0
VERBOSE=0
FAILS=0

# ------------------------------------------------------------------ 基础工具

say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
warn() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >&2; }
die() { printf 'cfmon-agent: %s\n' "$*" >&2; exit 1; }

conf_get() {
  [ -r "$CONF_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$CONF_FILE" 2>/dev/null | head -n 1 | tr -d '\r'
}

# 转义成可安全放进 JSON 字符串的形式
json_escape() {
  printf '%s' "${1:-}" | tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

usage() {
  cat <<'EOF'
用法: cfmon-agent [选项]

  --url URL        面板地址，例如 https://cfmon.example.com
  --token TOKEN    面板生成的服务器密钥
  --interval N     上报间隔秒数（默认 30，最小 5）
  --disk LIST      统计的挂载点，逗号分隔（默认 /）
  --once           只采集并上报一次就退出
  --dry-run        只打印 JSON 不发送
  --verbose        每次上报都打印结果
  --version        显示版本
  -h, --help       显示本帮助

配置文件 /etc/cfmon/agent.conf 中的键：CFMON_URL / CFMON_TOKEN / CFMON_INTERVAL / CFMON_DISK
优先级：命令行 > 环境变量 > 配置文件
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --url)      URL="${2:-}"; shift 2 ;;
      --token)    TOKEN="${2:-}"; shift 2 ;;
      --interval) INTERVAL="${2:-}"; shift 2 ;;
      --disk)     DISK_MOUNTS="${2:-}"; shift 2 ;;
      --once)     ONCE=1; shift ;;
      --dry-run)  DRY=1; shift ;;
      --verbose)  VERBOSE=1; shift ;;
      --version)  printf 'cfmon-agent %s\n' "$VERSION"; exit 0 ;;
      -h|--help)  usage; exit 0 ;;
      *)          die "未知参数: $1（--help 查看用法）" ;;
    esac
  done

  if [ -z "$URL" ]; then URL="$(conf_get CFMON_URL)"; fi
  if [ -z "$TOKEN" ]; then TOKEN="$(conf_get CFMON_TOKEN)"; fi
  if [ -z "$INTERVAL" ]; then INTERVAL="$(conf_get CFMON_INTERVAL)"; fi
  if [ -z "$DISK_MOUNTS" ]; then DISK_MOUNTS="$(conf_get CFMON_DISK)"; fi

  if [ -n "${CFMON_URL:-}" ]; then URL="$CFMON_URL"; fi
  if [ -n "${CFMON_TOKEN:-}" ]; then TOKEN="$CFMON_TOKEN"; fi
  if [ -n "${CFMON_INTERVAL:-}" ]; then INTERVAL="$CFMON_INTERVAL"; fi
  if [ -n "${CFMON_DISK:-}" ]; then DISK_MOUNTS="$CFMON_DISK"; fi

  URL=$(printf '%s' "$URL" | sed 's:/*$::')

  INTERVAL="${INTERVAL:-30}"
  case "$INTERVAL" in
    *[!0-9]*) die "间隔必须是整数秒: $INTERVAL" ;;
  esac
  if [ "$INTERVAL" -lt 5 ]; then INTERVAL=5; fi

  if [ -z "$DISK_MOUNTS" ]; then DISK_MOUNTS="/"; fi
}

# ------------------------------------------------------------------ 数据采集

read_static() {
  HOSTNAME=$(cat "$PROC/sys/kernel/hostname" 2>/dev/null || uname -n 2>/dev/null || printf 'unknown')
  HOSTNAME=$(printf '%s' "$HOSTNAME" | tr -d '\r\n')

  OS_NAME=$(sed -n 's/^PRETTY_NAME="\(.*\)"$/\1/p' /etc/os-release 2>/dev/null | head -n 1)
  if [ -z "$OS_NAME" ]; then OS_NAME=$(uname -s 2>/dev/null || printf 'Linux'); fi

  KERNEL=$(uname -r 2>/dev/null || printf '')
  ARCH=$(uname -m 2>/dev/null || printf '')

  CPU_MODEL=$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' "$PROC/cpuinfo" 2>/dev/null | head -n 1)
  if [ -z "$CPU_MODEL" ]; then
    CPU_MODEL=$(sed -n 's/^Hardware[[:space:]]*:[[:space:]]*//p' "$PROC/cpuinfo" 2>/dev/null | head -n 1)
  fi
  if [ -z "$CPU_MODEL" ]; then CPU_MODEL=$(uname -p 2>/dev/null || printf ''); fi

  CORES=0
  if [ -r "$PROC/cpuinfo" ]; then
    CORES=$(grep -c '^processor' "$PROC/cpuinfo" 2>/dev/null) || CORES=0
  fi
  if [ -z "$CORES" ]; then CORES=0; fi
}

read_cpu_snapshot() {
  # shellcheck disable=SC2046
  set -- $(head -n 1 "$PROC/stat")
  shift # 去掉首字段 "cpu"
  CPU_IDLE=$(( $4 + $5 ))
  CPU_TOTAL=$(( $1 + $2 + $3 + $4 + $5 + ${6:-0} + ${7:-0} + ${8:-0} ))
}

read_net_snapshot() {
  NET_RX=0
  NET_TX=0
  _n=0
  while IFS= read -r _line; do
    _n=$((_n + 1))
    if [ "$_n" -le 2 ]; then continue; fi   # 前两行是表头
    _if=$(printf '%s' "${_line%%:*}" | tr -d ' \t')
    if [ -z "$_if" ]; then continue; fi
    if [ "$_if" = "lo" ]; then continue; fi # 回环不计入
    # shellcheck disable=SC2086
    set -- ${_line#*:}
    if [ $# -lt 9 ]; then continue; fi
    NET_RX=$((NET_RX + $1))
    NET_TX=$((NET_TX + $9))
  done < "$PROC/net/dev"
}

read_mem() {
  MEM_TOTAL=0
  MEM_AVAIL=0
  MEM_FREE=0
  SWAP_TOTAL=0
  SWAP_FREE=0
  while IFS= read -r _line; do
    case "$_line" in
      MemTotal:*)     set -- $_line; MEM_TOTAL=$(( $2 * 1024 )) ;;
      MemAvailable:*) set -- $_line; MEM_AVAIL=$(( $2 * 1024 )) ;;
      MemFree:*)      set -- $_line; MEM_FREE=$(( $2 * 1024 )) ;;
      SwapTotal:*)    set -- $_line; SWAP_TOTAL=$(( $2 * 1024 )) ;;
      SwapFree:*)     set -- $_line; SWAP_FREE=$(( $2 * 1024 )) ;;
    esac
  done < "$PROC/meminfo"

  if [ "$MEM_AVAIL" -le 0 ]; then MEM_AVAIL=$MEM_FREE; fi   # 老内核没有 MemAvailable
  MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
  if [ "$MEM_USED" -lt 0 ]; then MEM_USED=0; fi
  SWAP_USED=$((SWAP_TOTAL - SWAP_FREE))
  if [ "$SWAP_USED" -lt 0 ]; then SWAP_USED=0; fi
}

read_disk() {
  DISK_TOTAL=0
  DISK_USED=0
  _oldifs=$IFS
  IFS=','
  for _m in $DISK_MOUNTS; do
    IFS=$_oldifs
    _m=$(printf '%s' "$_m" | tr -d ' ')
    if [ -n "$_m" ]; then
      # -P 保证一行一个文件系统，长设备名不会折行
      _df=$(df -kP "$_m" 2>/dev/null | tail -n 1) || _df=""
      if [ -n "$_df" ]; then
        # shellcheck disable=SC2086
        set -- $_df
        if [ $# -ge 3 ]; then
          DISK_TOTAL=$((DISK_TOTAL + $2 * 1024))
          DISK_USED=$((DISK_USED + $3 * 1024))
        fi
      fi
    fi
  done
  IFS=$_oldifs
}

count_procs() {
  set -- "$PROC"/[0-9]*
  case "${1:-}" in
    *'*') printf '0' ;;   # 没有匹配时 glob 原样返回
    *)    printf '%s' "$#" ;;
  esac
}

count_tcp() {
  _n=0
  for _f in "$PROC/net/tcp" "$PROC/net/tcp6"; do
    if [ -r "$_f" ]; then
      _c=$(wc -l < "$_f" | tr -d ' ')
      _n=$((_n + _c - 1))   # 减掉表头
    fi
  done
  if [ "$_n" -lt 0 ]; then _n=0; fi
  printf '%s' "$_n"
}

read_uptime() {
  _u=$(cut -d' ' -f1 "$PROC/uptime" 2>/dev/null || printf '0')
  UPTIME=${_u%%.*}
  if [ -z "$UPTIME" ]; then UPTIME=0; fi
}

read_load() {
  # shellcheck disable=SC2046
  set -- $(cut -d' ' -f1-3 "$PROC/loadavg" 2>/dev/null)
  LOAD1=${1:-0}
  LOAD5=${2:-0}
  LOAD15=${3:-0}
}

collect() {
  if [ ! -r "$PROC/stat" ]; then die "读不到 $PROC/stat —— 这个脚本只能在 Linux 上跑"; fi

  read_static
  read_cpu_snapshot; _t1=$CPU_TOTAL; _i1=$CPU_IDLE
  read_net_snapshot; _rx1=$NET_RX; _tx1=$NET_TX
  _beg=$(date +%s)

  sleep "$SAMPLE_WAIT"

  read_cpu_snapshot; _t2=$CPU_TOTAL; _i2=$CPU_IDLE
  read_net_snapshot; _rx2=$NET_RX; _tx2=$NET_TX
  _end=$(date +%s)

  _dt=$((_end - _beg))
  if [ "$_dt" -lt 1 ]; then _dt=1; fi

  _d_total=$((_t2 - _t1))
  _d_idle=$((_i2 - _i1))
  CPU_PCT=0
  if [ "$_d_total" -gt 0 ]; then
    CPU_PCT=$(((_d_total - _d_idle) * 100 / _d_total))
    if [ "$CPU_PCT" -lt 0 ]; then CPU_PCT=0; fi
    if [ "$CPU_PCT" -gt 100 ]; then CPU_PCT=100; fi
  fi

  _d_rx=$((_rx2 - _rx1))
  _d_tx=$((_tx2 - _tx1))
  if [ "$_d_rx" -lt 0 ]; then _d_rx=0; fi
  if [ "$_d_tx" -lt 0 ]; then _d_tx=0; fi
  RX_RATE=$((_d_rx / _dt))
  TX_RATE=$((_d_tx / _dt))

  read_mem
  read_disk
  read_uptime
  read_load
  PROCS=$(count_procs)
  TCP=$(count_tcp)
  TS=$(date +%s)
}

build_json() {
  printf '{"hostname":"%s","os":"%s","arch":"%s","kernel":"%s","cpu_model":"%s","cpu_cores":%s,"agent":"%s","ts":%s,"uptime":%s,"cpu":%s,"load":[%s,%s,%s],"mem":{"total":%s,"used":%s},"swap":{"total":%s,"used":%s},"disk":{"total":%s,"used":%s},"net":{"rx_rate":%s,"tx_rate":%s,"rx_total":%s,"tx_total":%s},"procs":%s,"tcp":%s}' \
    "$(json_escape "$HOSTNAME")" \
    "$(json_escape "$OS_NAME")" \
    "$(json_escape "$ARCH")" \
    "$(json_escape "$KERNEL")" \
    "$(json_escape "$CPU_MODEL")" \
    "${CORES:-0}" "$VERSION" "$TS" "$UPTIME" "$CPU_PCT" \
    "$LOAD1" "$LOAD5" "$LOAD15" \
    "$MEM_TOTAL" "$MEM_USED" "$SWAP_TOTAL" "$SWAP_USED" \
    "$DISK_TOTAL" "$DISK_USED" \
    "$RX_RATE" "$TX_RATE" "$_rx2" "$_tx2" \
    "$PROCS" "$TCP"
}

# ---------------------------------------------------------------------- 上报

post_report() {
  _payload=$1
  _tmp=$(mktemp 2>/dev/null || printf '/tmp/cfmon-agent.%s' "$$")
  printf '%s' "$_payload" >"$_tmp"

  _try=1
  _rc=1
  while [ "$_try" -le 3 ]; do
    _code=000
    if command -v curl >/dev/null 2>&1; then
      _code=$(curl -sS -o /dev/null -w '%{http_code}' -m 15 -X POST "$URL/api/report" \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $TOKEN" \
        -H "User-Agent: cfmon-agent/$VERSION" \
        --data-binary "@$_tmp" 2>/dev/null) || _code=000
    elif command -v wget >/dev/null 2>&1; then
      _code=$(wget -q -T 15 -O /dev/null --header='Content-Type: application/json' \
        --header="Authorization: Bearer $TOKEN" \
        --post-file="$_tmp" "$URL/api/report" 2>&1 \
        | sed -n 's/.*HTTP[/0-9.]* \([0-9]\{3\}\).*/\1/p' | tail -n 1) || _code=000
      if [ -z "$_code" ]; then _code=000; fi
    else
      rm -f "$_tmp"
      die "服务器上没有 curl 也没有 wget，无法上报"
    fi

    if [ "$_code" = "200" ]; then
      rm -f "$_tmp"
      return 0
    fi

    case "$_code" in
      4*)
        rm -f "$_tmp"
        warn "上报被拒绝（HTTP $_code）：多半是密钥已失效，请到面板重置密钥后重装"
        return 1
        ;;
      000) warn "连接失败（第 $_try 次）" ;;
      *)   warn "服务端返回 HTTP $_code（第 $_try 次）" ;;
    esac

    _try=$((_try + 1))
    if [ "$_try" -le 3 ]; then sleep $((_try * 2)); fi
  done

  rm -f "$_tmp"
  return 1
}

# ---------------------------------------------------------------------- 入口

main() {
  parse_args "$@"

  if [ "$DRY" != 1 ]; then
    if [ -z "$URL" ]; then die "缺少 --url（或用 CFMON_URL / 配置文件）"; fi
    if [ -z "$TOKEN" ]; then die "缺少 --token（或用 CFMON_TOKEN / 配置文件）"; fi
    case "$URL" in
      http://*|https://*) : ;;
      *) die "--url 必须以 http:// 或 https:// 开头" ;;
    esac
  fi

  if [ "$ONCE" = 1 ]; then
    collect
    _json=$(build_json)
    if [ "$DRY" = 1 ]; then
      printf '%s\n' "$_json"
      return 0
    fi
    if post_report "$_json"; then
      say "上报成功：cpu=${CPU_PCT}% mem=$((MEM_USED / 1048576))MB disk=$((DISK_USED / 1073741824))GB"
      return 0
    fi
    return 1
  fi

  say "cfmon-agent $VERSION 启动：$URL 每 ${INTERVAL} 秒上报一次"
  while :; do
    _cycle=$(date +%s)
    if collect 2>/dev/null; then
      _json=$(build_json)
      if post_report "$_json"; then
        if [ "$FAILS" -gt 0 ]; then say "已恢复上报"; fi
        FAILS=0
        if [ "$VERBOSE" = 1 ]; then say "上报成功 cpu=${CPU_PCT}%"; fi
      else
        FAILS=$((FAILS + 1))
      fi
    else
      warn "采集失败，跳过本轮"
    fi
    _elapsed=$(( $(date +%s) - _cycle ))
    _wait=$((INTERVAL - _elapsed))
    if [ "$_wait" -lt 2 ]; then _wait=2; fi
    sleep "$_wait"
  done
}

main "$@"
