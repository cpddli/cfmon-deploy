#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""cfmon-agent —— 服务器指标采集上报端

只依赖 Python 3 标准库，从 /proc 读取数据，POST 到 cfmon 面板。
常驻模式：每 N 秒采集一次（默认 30 秒）。

用法：
    cfmon-agent                                  # 读取 /etc/cfmon/agent.conf
    cfmon-agent --url https://panel --token xx   # 手动指定
    cfmon-agent --once                           # 只上报一次（自检 / 配合 cron）

环境变量（优先级：命令行 > 环境变量 > 配置文件）：
    CFMON_URL, CFMON_TOKEN, CFMON_INTERVAL
"""

import argparse
import json
import os
import platform
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request

VERSION = "1.0.0"
CONF_PATH = "/etc/cfmon/agent.conf"


# --------------------------------------------------------------------- 工具

def log(message):
    sys.stdout.write("[%s] %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), message))
    sys.stdout.flush()


def read_conf(path):
    """解析 KEY=VALUE 形式的配置文件。"""
    conf = {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                conf[key.strip()] = value.strip().strip('"').strip("'")
    except OSError:
        pass
    return conf


# ------------------------------------------------------------------ 指标采集

def read_cpu_times():
    """返回 (总时间, 空闲时间)，单位是内核的 jiffies。"""
    with open("/proc/stat", "r", encoding="utf-8") as fh:
        parts = fh.readline().split()
    values = [int(x) for x in parts[1:9]]  # user nice system idle iowait irq softirq steal
    while len(values) < 8:
        values.append(0)
    idle = values[3] + values[4]
    return sum(values), idle


def read_net_bytes():
    """所有非 lo 网卡的累计收/发字节数。"""
    rx = tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as fh:
        lines = fh.readlines()[2:]
    for line in lines:
        name, _, rest = line.partition(":")
        if name.strip() == "lo":
            continue
        fields = rest.split()
        if len(fields) < 9:
            continue
        rx += int(fields[0])
        tx += int(fields[8])
    return rx, tx


def read_meminfo():
    info = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as fh:
        for line in fh:
            key, _, rest = line.partition(":")
            chunks = rest.split()
            if chunks and chunks[0].isdigit():
                info[key] = int(chunks[0]) * 1024  # kB -> bytes
    return info


def read_uptime():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as fh:
            return float(fh.read().split()[0])
    except (OSError, IndexError, ValueError):
        return 0.0


def read_disk(mounts):
    total = used = 0
    for mount in mounts:
        try:
            st = os.statvfs(mount)
        except OSError:
            continue
        total += st.f_blocks * st.f_frsize
        used += (st.f_blocks - st.f_bfree) * st.f_frsize
    return total, used


def count_processes():
    try:
        return sum(1 for name in os.listdir("/proc") if name.isdigit())
    except OSError:
        return 0


def count_tcp():
    total = 0
    for path in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                total += max(0, len(fh.readlines()) - 1)  # 去掉表头
        except OSError:
            pass
    return total


def os_pretty_name():
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.platform()


def cpu_model():
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.lower().startswith(("model name", "hardware", "cpu model")):
                    return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or ""


def collect(args):
    """采样两次算出 CPU 占用与网络速率，再拼成快照。"""
    cpu0_total, cpu0_idle = read_cpu_times()
    rx0, tx0 = read_net_bytes()
    started = time.time()

    time.sleep(args.sample_wait)

    cpu1_total, cpu1_idle = read_cpu_times()
    rx1, tx1 = read_net_bytes()
    elapsed = max(time.time() - started, 0.05)

    total_delta = cpu1_total - cpu0_total
    idle_delta = cpu1_idle - cpu0_idle
    if total_delta <= 0:
        cpu_pct = 0.0
    else:
        cpu_pct = max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0))

    mem = read_meminfo()
    mem_total = mem.get("MemTotal", 0)
    mem_available = mem.get("MemAvailable", mem.get("MemFree", 0))
    mem_used = max(0, mem_total - mem_available)

    swap_total = mem.get("SwapTotal", 0)
    swap_used = max(0, swap_total - mem.get("SwapFree", 0))

    disk_total, disk_used = read_disk(args.disk)

    try:
        load = [round(x, 2) for x in os.getloadavg()]
    except (OSError, AttributeError):
        load = [0.0, 0.0, 0.0]

    return {
        "hostname": socket.gethostname()[:128],
        "os": os_pretty_name()[:128],
        "arch": platform.machine()[:32],
        "kernel": platform.release()[:96],
        "cpu_model": cpu_model()[:160],
        "cpu_cores": os.cpu_count() or 0,
        "agent": VERSION,
        "ts": int(time.time()),
        "uptime": int(read_uptime()),
        "cpu": round(cpu_pct, 1),
        "load": load,
        "mem": {"total": mem_total, "used": mem_used},
        "swap": {"total": swap_total, "used": swap_used},
        "disk": {"total": disk_total, "used": disk_used},
        "net": {
            "rx_rate": round((rx1 - rx0) / elapsed, 1),
            "tx_rate": round((tx1 - tx0) / elapsed, 1),
            "rx_total": rx1,
            "tx_total": tx1,
        },
        "procs": count_processes(),
        "tcp": count_tcp(),
    }


# --------------------------------------------------------------------- 上报

def post_report(url, token, payload, retries=3):
    """返回 (状态码, 响应文本)。4xx 视为永久失败，不重试。"""
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    endpoint = url.rstrip("/") + "/api/report"
    last_error = "unknown"

    for attempt in range(retries):
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + token,
                "User-Agent": "cfmon-agent/" + VERSION,
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return response.status, response.read(2048).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            text = exc.read(2048).decode("utf-8", "replace")
            if 400 <= exc.code < 500:
                return exc.code, text
            last_error = "HTTP %s: %s" % (exc.code, text[:200])
        except ssl.SSLError as exc:
            last_error = "TLS 握手失败（检查系统 CA 证书是否安装：ca-certificates）: %s" % exc
        except (urllib.error.URLError, OSError) as exc:
            last_error = "网络错误: %s" % exc
        except Exception as exc:  # noqa: BLE001 - 常驻进程不能因为一次异常退出
            last_error = "未知错误: %s" % exc

        if attempt < retries - 1:
            time.sleep(min(20, 2 * (2 ** attempt)))

    return 0, last_error


# ---------------------------------------------------------------------- 入口

def parse_args():
    conf = read_conf(CONF_PATH)

    parser = argparse.ArgumentParser(description="cfmon 服务器监控上报端")
    parser.add_argument("--url", default=os.environ.get("CFMON_URL") or conf.get("CFMON_URL", ""),
                        help="面板地址，例如 https://panel.example.com")
    parser.add_argument("--token", default=os.environ.get("CFMON_TOKEN") or conf.get("CFMON_TOKEN", ""),
                        help="面板为这台服务器生成的一次性密钥")
    parser.add_argument("--interval", type=float,
                        default=float(os.environ.get("CFMON_INTERVAL") or conf.get("CFMON_INTERVAL") or 30),
                        help="上报间隔，秒（默认 30，最小 5）")
    parser.add_argument("--disk", default=os.environ.get("CFMON_DISK") or conf.get("CFMON_DISK") or "/",
                        help="要统计的挂载点，逗号分隔（默认 /）")
    parser.add_argument("--sample-wait", type=float, default=1.0,
                        help="采集窗口，秒（默认 1.0，越大 CPU/网速越平滑）")
    parser.add_argument("--once", action="store_true", help="只上报一次后退出")
    parser.add_argument("--verbose", action="store_true", help="每次都打印上报结果")
    parser.add_argument("--version", action="version", version="cfmon-agent " + VERSION)

    args = parser.parse_args()
    if not args.url or not args.token:
        parser.error("必须提供 --url 和 --token，或设置 CFMON_URL / CFMON_TOKEN")
    if not args.url.startswith(("http://", "https://")):
        parser.error("--url 必须以 http:// 或 https:// 开头")
    args.interval = max(5.0, args.interval)
    args.disk = [m.strip() for m in args.disk.split(",") if m.strip()] or ["/"]
    return args


def main():
    args = parse_args()

    if args.once:
        payload = collect(args)
        status, text = post_report(args.url, args.token, payload)
        if status == 200:
            log("上报成功：cpu=%.1f%% mem=%.1f%% disk=%.1f%%"
                % (payload["cpu"],
                   100.0 * payload["mem"]["used"] / max(1, payload["mem"]["total"]),
                   100.0 * payload["disk"]["used"] / max(1, payload["disk"]["total"])))
            return 0
        log("上报失败（%s）：%s" % (status or "无响应", text[:300]))
        return 1

    log("cfmon-agent %s 启动：%s 每 %.0f 秒上报一次" % (VERSION, args.url, args.interval))

    failures = 0
    while True:
        began = time.time()
        try:
            payload = collect(args)
            status, text = post_report(args.url, args.token, payload)
            if status == 200:
                if failures:
                    log("已恢复上报（此前连续失败 %d 次）" % failures)
                elif args.verbose:
                    log("上报成功 cpu=%.1f%%" % payload["cpu"])
                failures = 0
            else:
                failures += 1
                log("上报失败（%s）：%s" % (status or "无响应", text[:300]))
                if status in (401, 403):
                    log("密钥可能已失效：请到面板「重置密钥」后重新执行安装命令")
        except KeyboardInterrupt:
            log("收到中断，退出")
            return 0
        except Exception as exc:  # noqa: BLE001
            failures += 1
            log("采集异常：%s" % exc)

        try:
            time.sleep(max(1.0, args.interval - (time.time() - began)))
        except KeyboardInterrupt:
            log("收到中断，退出")
            return 0


if __name__ == "__main__":
    sys.exit(main())
