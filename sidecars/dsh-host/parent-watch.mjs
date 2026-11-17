// 由 daemon 以 `node --import parent-watch.mjs …` 预加载进 DSH 进程。
//
// daemon 正常退出时会结束 DSH；但 daemon 被强杀或崩溃时来不及，DSH 就成了孤儿（父进程变成 launchd），
// 还会不停拉起自己的 `you-brain mcp`，一直挂到重启电脑。这里每两秒看一眼父进程号：变了就按正常信号退出，
// 让 DSH 自己收尾（结束它的子进程）；五秒后还没退就直接退出。
// DSH 再 fork 的 Node 子进程会继承 --import，在 DSH 退出后同样跟着退出。

const parent = process.ppid;
if (parent > 1) {
  const timer = setInterval(() => {
    if (process.ppid === parent) return;
    clearInterval(timer);
    setTimeout(() => process.exit(0), 5_000).unref();
    process.kill(process.pid, "SIGTERM");
  }, 2_000);
  timer.unref();
}
