import { Command } from "commander";

import { connectDaemon, fail, supportedPlatform } from "../env.js";
import { createRuntimeServiceManager, type ServiceStatus } from "./manager.js";
import type { ServicePlatform } from "./paths.js";

export function registerServiceCommand(program: Command): void {
  const service = program.command("service").description("安装、卸载或查看开机自启服务");

  service
    .command("install")
    .description("生成并安装开机自启单元")
    .option("--no-start", "只写入单元，不立即启动")
    .option("--print", "只打印将写入的单元内容和路径")
    .action(async (opts: { start?: boolean; print?: boolean }) => {
      try {
        await installService({ start: opts.start !== false, printOnly: Boolean(opts.print) });
      } catch (error) {
        fail(error);
      }
    });

  service
    .command("uninstall")
    .description("停止并删除开机自启单元")
    .action(async () => {
      try {
        await uninstallService();
      } catch (error) {
        fail(error);
      }
    });

  service
    .command("status")
    .description("查看开机自启单元和本机 daemon")
    .action(async () => {
      try {
        await statusService();
      } catch (error) {
        fail(error);
      }
    });
}

async function installService(options: { start: boolean; printOnly: boolean }): Promise<void> {
  const platform = supportedPlatform();
  const manager = createRuntimeServiceManager();
  if (options.printOnly) {
    const preview = manager.preview();
    console.log(`单元：${preview.unitPath}`);
    console.log(preview.body);
    return;
  }
  const result = await manager.install({ start: options.start });
  console.log(`已写入 ${result.unitPath}`);
  if (result.started) {
    console.log("服务已启动。");
  } else if (platform === "darwin") {
    console.log("未立即启动。下次登录时自动加载。");
  } else {
    console.log("已启用，未立即启动。");
  }
  for (const warning of result.warnings) console.log(warning);
  console.log("服务器首次使用仍需完成 you-brain setup（Drive 授权与模型）。");
  console.log("用 you-brain devices --set-main <id> 设为主设备。");
}

async function uninstallService(): Promise<void> {
  supportedPlatform();
  const { removed } = await createRuntimeServiceManager().uninstall();
  if (removed.length === 0) {
    console.log("服务未安装。");
    return;
  }
  for (const path of removed) console.log(`已删除 ${path}`);
}

async function statusService(): Promise<void> {
  const platform = supportedPlatform();
  const manager = createRuntimeServiceManager();
  const status = await manager.status({ daemonReachable: await probeDaemon() });
  console.log(status.installed ? "服务已安装" : "服务未安装");
  console.log(platformState(platform, status));
  console.log(status.running ? "运行中" : "已停止");
  console.log(status.pid === null ? "pid：无" : `pid：${status.pid}`);
  console.log(`单元：${status.unitPath}`);
  console.log(`日志：${status.logHint}`);
  console.log(status.daemonReachable ? "daemon 本机接口可达" : "daemon 本机接口不可达");
}

function platformState(platform: ServicePlatform, status: ServiceStatus): string {
  if (platform === "linux") return status.enabled ? "已启用" : "未启用";
  return status.loaded ? "已加载" : "未加载";
}

async function probeDaemon(): Promise<boolean> {
  try {
    const client = await connectDaemon();
    await client.status();
    return true;
  } catch {
    return false;
  }
}
