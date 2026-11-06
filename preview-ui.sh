#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ -z "${PREVIEW_PYTHON:-}" ]]; then
  if [[ -x .venv-preview/bin/python ]]; then
    PREVIEW_PYTHON=.venv-preview/bin/python
  else
    PREVIEW_PYTHON=.venv/bin/python
  fi
fi
if [[ ! -x "$PREVIEW_PYTHON" ]]; then
  echo "请先创建 .venv-preview 或 .venv 并安装项目依赖，或设置 PREVIEW_PYTHON 指向可用 Python。" >&2
  exit 1
fi
exec "$PREVIEW_PYTHON" -m app.preview "$@"
