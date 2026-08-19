#!/bin/sh

# 处理 nginx 配置
export MAX_FILE_SIZE=${MAX_FILE_SIZE_MB:-25}M
export APP_HOST=${APP_HOST:-weflow-core}
export APP_PORT=${APP_PORT:-3100}
export APP_SCHEME=${APP_SCHEME:-http}
envsubst '${MAX_FILE_SIZE} ${APP_HOST} ${APP_PORT} ${APP_SCHEME}' < /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf

# 启动 nginx
exec nginx -g 'daemon off;'
