#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_DIR="${HOME}/.tinyai-observability"
ENV_FILE="${ENV_DIR}/tinyai-observability.env"
TEMPLATE_ENV="${REPO_ROOT}/config/tinyai-observability.env"

TOOLS="claude,codex"
USER_NAME=""
USER_EMAIL=""
USER_ID=""
TEAM=""
COLLECTOR_URL=""
COLLECTOR_URLS=""
DASHBOARD_URL=""
DASHBOARD_URLS=""
RUN_BUILD="0"
DRY_RUN="0"

usage() {
  cat <<'EOF'
TinyAI AI 插件一键安装脚本

用法：
  bash scripts/install_teammate_ai_plugins.sh --name 张三 --email zhangsan@example.com

常用参数：
  --tools claude,codex          安装哪些插件，默认 claude,codex
  --name 张三                   用户显示名
  --email zhangsan@example.com  用户邮箱
  --user-id zhangsan            用户 ID，默认使用邮箱
  --team hotel                  团队，可选
  --collector-url URL           主 collector 地址，可选
  --collector-urls URLS         fallback collector 地址，逗号分隔，可选
  --dashboard-url URL           dashboard 地址，可选
  --dashboard-urls URLS         fallback dashboard 地址，逗号分隔，可选
  --build                       安装前重新 build runtime；默认使用仓库里已提交的 dist
  --dry-run                     只预览，不写入 ~/.claude / ~/.codex

示例：
  bash scripts/install_teammate_ai_plugins.sh --name 李四 --email lisi@example.com --team hotel
  bash scripts/install_teammate_ai_plugins.sh --tools claude --name 李四 --email lisi@example.com
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tools) TOOLS="${2:-}"; shift 2 ;;
    --name) USER_NAME="${2:-}"; shift 2 ;;
    --email) USER_EMAIL="${2:-}"; shift 2 ;;
    --user-id) USER_ID="${2:-}"; shift 2 ;;
    --team) TEAM="${2:-}"; shift 2 ;;
    --collector-url) COLLECTOR_URL="${2:-}"; shift 2 ;;
    --collector-urls) COLLECTOR_URLS="${2:-}"; shift 2 ;;
    --dashboard-url) DASHBOARD_URL="${2:-}"; shift 2 ;;
    --dashboard-urls) DASHBOARD_URLS="${2:-}"; shift 2 ;;
    --build) RUN_BUILD="1"; shift ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数：$1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${USER_NAME}" ]]; then
  read -r -p "请输入你的姓名/显示名: " USER_NAME
fi

if [[ -z "${USER_EMAIL}" ]]; then
  read -r -p "请输入你的邮箱: " USER_EMAIL
fi

if [[ -z "${USER_ID}" ]]; then
  USER_ID="${USER_EMAIL}"
fi

if [[ -z "${USER_NAME}" || -z "${USER_EMAIL}" ]]; then
  echo "姓名和邮箱不能为空。" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node。请先安装 Node.js 后再运行。" >&2
  exit 1
fi

if [[ ! -f "${TEMPLATE_ENV}" ]]; then
  echo "找不到默认配置模板：${TEMPLATE_ENV}" >&2
  exit 1
fi

echo "TinyAI Observability 插件安装"
echo "项目目录：${REPO_ROOT}"
echo "用户：${USER_NAME} <${USER_EMAIL}>"
echo "插件：${TOOLS}"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "[dry-run] 将会写入配置：${ENV_FILE}"
else
  mkdir -p "${ENV_DIR}"
  if [[ ! -f "${ENV_FILE}" ]]; then
    cp "${TEMPLATE_ENV}" "${ENV_FILE}"
  fi
fi

export TINYAI_INSTALL_ENV_FILE="${ENV_FILE}"
export TINYAI_INSTALL_TEMPLATE_ENV="${TEMPLATE_ENV}"
export TINYAI_INSTALL_DRY_RUN="${DRY_RUN}"
export TINYAI_INSTALL_USER_NAME="${USER_NAME}"
export TINYAI_INSTALL_USER_EMAIL="${USER_EMAIL}"
export TINYAI_INSTALL_USER_ID="${USER_ID}"
export TINYAI_INSTALL_TEAM="${TEAM}"
export TINYAI_INSTALL_COLLECTOR_URL="${COLLECTOR_URL}"
export TINYAI_INSTALL_COLLECTOR_URLS="${COLLECTOR_URLS}"
export TINYAI_INSTALL_DASHBOARD_URL="${DASHBOARD_URL}"
export TINYAI_INSTALL_DASHBOARD_URLS="${DASHBOARD_URLS}"

node <<'NODE'
const fs = require("node:fs");

const envFile = process.env.TINYAI_INSTALL_ENV_FILE;
const templateFile = process.env.TINYAI_INSTALL_TEMPLATE_ENV;
const dryRun = process.env.TINYAI_INSTALL_DRY_RUN === "1";

const desired = {
  TINYAI_OBS_USER_NAME: process.env.TINYAI_INSTALL_USER_NAME || "",
  TINYAI_OBS_USER_EMAIL: process.env.TINYAI_INSTALL_USER_EMAIL || "",
  TINYAI_OBS_USER_ID: process.env.TINYAI_INSTALL_USER_ID || "",
  TINYAI_OBS_TEAM: process.env.TINYAI_INSTALL_TEAM || "",
  TINYAI_OBS_COLLECTOR_URL: process.env.TINYAI_INSTALL_COLLECTOR_URL || "",
  TINYAI_OBS_COLLECTOR_URLS: process.env.TINYAI_INSTALL_COLLECTOR_URLS || "",
  TINYAI_OBS_DASHBOARD_URL: process.env.TINYAI_INSTALL_DASHBOARD_URL || "",
  TINYAI_OBS_DASHBOARD_URLS: process.env.TINYAI_INSTALL_DASHBOARD_URLS || "",
};

let content = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, "utf8")
  : fs.readFileSync(templateFile, "utf8");

function setEnvLine(input, key, value) {
  if (!value) return input;
  const escaped = value.replace(/\n/g, " ").trim();
  const line = `${key}=${escaped}`;
  const pattern = new RegExp(`^#?\\s*${key}=.*$`, "m");
  if (pattern.test(input)) {
    return input.replace(pattern, line);
  }
  return `${input.trimEnd()}\n${line}\n`;
}

for (const [key, value] of Object.entries(desired)) {
  content = setEnvLine(content, key, value);
}

if (dryRun) {
  console.log(`[dry-run] 配置文件会更新：${envFile}`);
} else {
  fs.writeFileSync(envFile, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  console.log(`已更新配置：${envFile}`);
}
NODE

cd "${REPO_ROOT}"

if [[ "${RUN_BUILD}" == "1" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "未找到 npm，无法执行 --build。" >&2
    exit 1
  fi
  echo "开始重新 build 插件 runtime..."
  npm --prefix plugin-runtime install
  npm run build:runtime
  npm run sync:runtimes
fi

INSTALL_ARGS=()
if [[ "${DRY_RUN}" == "1" ]]; then
  INSTALL_ARGS+=("--dry-run")
fi

IFS=',' read -ra TOOL_LIST <<< "${TOOLS}"
for tool in "${TOOL_LIST[@]}"; do
  normalized="$(echo "${tool}" | tr '[:upper:]' '[:lower:]' | xargs)"
  case "${normalized}" in
    claude)
      echo "安装 Claude Code 插件..."
      node scripts/install_claude_observability_plugin.mjs "${INSTALL_ARGS[@]}"
      ;;
    codex)
      echo "安装 Codex 插件..."
      node scripts/install_codex_observability_plugin.mjs "${INSTALL_ARGS[@]}"
      ;;
    "")
      ;;
    *)
      echo "不支持的插件：${tool}，目前支持 claude,codex。" >&2
      exit 2
      ;;
  esac
done

cat <<EOF

安装完成。

下一步：
1. 重启 Claude Code / Codex，或者重新打开 VS Code / 新建 Codex thread。
2. 随便问一句“你好”。
3. 打开 dashboard 查看 tool=claude / tool=codex 是否出现心跳和会话。

Dashboard:
  ${DASHBOARD_URL:-http://192.168.215.94:18081}
EOF
