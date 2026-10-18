#!/bin/zsh
# 用法：run.sh <任务名>   读取 .orchestration/<任务名>.md 派发给 grok
cd /Users/john/private/ai/you-brain
export PATH=$HOME/.local/share/fnm/node-versions/v22.15.0/installation/bin:$PATH
name=$1
model=${GROK_MODEL:-grok-4.7-build-fast}
log=.orchestration/logs/$name.log
[[ -f .orchestration/$name.md ]] || { echo "缺少任务文件 .orchestration/$name.md"; exit 2; }

# 启动前检查：模型可用、已登录。失败重试 3 次，仍失败则不派发。
preflight_ok=0
for i in 1 2 3; do
  if out=$(cd /tmp && grok -p "reply ok" -m "$model" --max-turns 1 --tools "" 2>&1) && [[ "$out" == *ok* ]]; then
    preflight_ok=1; break
  fi
  echo "预检第 $i 次失败：$(echo "$out" | tail -2)" >&2
  sleep 20
done
if (( ! preflight_ok )); then
  { echo "预检失败：模型 $model 不可用，未派发"; echo "$out" | tail -5; echo "EXIT 3"; } > $log
  tail -8 $log
  exit 3
fi

grok -p "$(cat .orchestration/$name.md)" --always-approve --cwd /Users/john/private/ai/you-brain -m $model --effort ${GROK_EFFORT:-high} > $log 2>&1
echo "EXIT $?" >> $log
tail -60 $log
