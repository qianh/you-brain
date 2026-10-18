#!/bin/zsh
# 用法：run.sh <任务名>   读取 .orchestration/<任务名>.md 派发给 grok
cd /Users/john/private/ai/you-brain
export PATH=$HOME/.local/share/fnm/node-versions/v22.15.0/installation/bin:$PATH
name=$1
grok -p "$(cat .orchestration/$name.md)" --always-approve --cwd /Users/john/private/ai/you-brain -m ${GROK_MODEL:-grok-4.7} --effort ${GROK_EFFORT:-high} > .orchestration/logs/$name.log 2>&1
echo "EXIT $?" >> .orchestration/logs/$name.log
tail -60 .orchestration/logs/$name.log
