#!/usr/bin/env bash
# 纸间 · Paper Journal 启动脚本（macOS / Linux）
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "没有找到 Node.js，请先安装 Node 18+：https://nodejs.org"
  exit 1
fi

echo "正在启动纸间…"
node server.mjs --open
