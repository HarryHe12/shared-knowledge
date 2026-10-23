#!/bin/bash
# 知识库系统自动部署：GitHub main 有新提交时拉取并重启对应服务。
# 安全网：更新后服务起不来就自动回滚到上一个版本。
# 由 cron 每 3 分钟调用一次（/etc/cron.d/kb-auto-deploy）。

REPO=/opt/kb-system/app/shared-knowledge
LOG=/opt/kb-system/auto-deploy.log

cd "$REPO" || exit 1
git fetch -q --depth 1 origin main || exit 0

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0   # 没有新提交，收工

CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" 2>/dev/null)
# 浅克隆下两段历史看似无关，不能快进合并；部署机无本地改动，直接对齐到新提交
git reset --hard "$REMOTE" -q || { echo "$(date '+%F %T') 切换到 $REMOTE 失败" >> "$LOG"; exit 1; }
NEED_CORE=$(echo "$CHANGED" | grep -c '^team-app/' || true)
NEED_COLLECTOR=$(echo "$CHANGED" | grep -c '^kb-system/' || true)

FAILED=0
[ "$NEED_CORE" -gt 0 ] && { systemctl restart kb-core; sleep 3; systemctl is-active --quiet kb-core || FAILED=1; }
[ "$NEED_COLLECTOR" -gt 0 ] && { systemctl restart kb-collector; sleep 3; systemctl is-active --quiet kb-collector || FAILED=1; }

if [ "$FAILED" = 1 ]; then
  echo "$(date '+%F %T') 更新后服务起不来，自动回滚 $REMOTE -> $LOCAL" >> "$LOG"
  git reset --hard "$LOCAL" -q
  systemctl restart kb-core kb-collector
  exit 1
fi

echo "$(date '+%F %T') 已更新 ${LOCAL:0:7} -> ${REMOTE:0:7}（影响目录：$(echo "$CHANGED" | cut -d/ -f1 | sort -u | tr '\n' ' ')）" >> "$LOG"
