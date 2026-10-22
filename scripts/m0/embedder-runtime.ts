/**
 * M0 第 1 项：onnxruntime-node 在 Bun 与编译产物里能否加载。
 *
 * 前置条件：
 * - 用 bun 运行。不下载模型，不读 ~/.you-brain 或 Application Support/you-brain。
 * - 编译产物：dist/daemon/<triple>/you-brain 及其旁边的 vendor/。没有则跳过该阶段。
 * - 端到端嵌入需要 Xenova/multilingual-e5-small。本脚本只检查
 *   ~/.cache/huggingface/hub/models--Xenova--multilingual-e5-small 在不在，不读取权重。
 *
 * 用法：bun scripts/m0/embedder-runtime.ts
 *
 * 编译产物没有「只加载原生模块」的子命令。native-check 会接着做嵌入。
 * 本脚本用 sandbox-exec 禁网后跑 `you-brain native-check`，模型缓存指向临时目录。
 * vendor 阶段在 bun 里复现 loadPackage 的解析：createRequire(vendor 里的
 * transformers.node.mjs).resolve("onnxruntime-node")。这与编译进程不是同一次 dlopen。
 * YOU_BRAIN_VENDOR_DIR 只由外壳写入，resolver.ts 不读它。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { compiledBindingLoaded, probeCompiledBinary } from "./compiled-probe.ts";
import { hostTriple, repoRoot } from "./layout.ts";
import { loadOrtFrom, sourceTransformers, vendorTransformers } from "./native-load.ts";
import { clip, emit, errorText, type M0Result } from "./result.ts";
import {
  installVendorResolver,
  vendorNodeModulesDir,
} from "../../packages/core/src/native/resolver.ts";

const item = "embedder-runtime";
const modelCache = join(homedir(), ".cache/huggingface/hub/models--Xenova--multilingual-e5-small");

function resolveOrt(from: string, resolver: string): ReturnType<typeof loadOrtFrom> & { resolved: string | null } {
  try {
    const resolved = Bun.resolveSync("onnxruntime-node", from);
    return { ...loadOrtFrom(resolved, resolver, resolved), resolved };
  } catch (error) {
    return {
      ok: false,
      error: errorText(error),
      version: null,
      binding: null,
      bindingExists: false,
      resolver,
      resolved: null,
    };
  }
}

function installedOrtIndex(): string | null {
  const root = join(repoRoot, "node_modules/.bun");
  if (!existsSync(root)) return null;
  const glob = new Bun.Glob("onnxruntime-node@*/node_modules/onnxruntime-node/dist/index.js");
  const found = [...glob.scanSync({ cwd: root })].sort();
  const first = found[0];
  return first ? join(root, first) : null;
}

async function main(): Promise<void> {
  const binary = join(repoRoot, "dist/daemon", hostTriple(), "you-brain");
  const binaryExists = existsSync(binary);
  const vendor = binaryExists ? vendorNodeModulesDir(binary) : null;
  const sourceAnchor = join(repoRoot, "packages/core/package.json");
  const source = existsSync(sourceTransformers)
    ? loadOrtFrom(sourceTransformers, "createRequire(packages/core transformers.node.mjs)。这是 onnx-node.js 的 Node 解析，不走 bun 的 .bun 布局")
    : {
        ok: false,
        error: `找不到 ${sourceTransformers}`,
        version: null,
        binding: null,
        bindingExists: false,
        resolver: "source",
      };
  const bunResolveFromCore = resolveOrt(sourceAnchor, "Bun.resolveSync from packages/core/package.json");
  const bunResolveFromTransformers = existsSync(sourceTransformers)
    ? resolveOrt(sourceTransformers, "Bun.resolveSync from transformers.node.mjs")
    : {
        ok: false,
        error: `找不到 ${sourceTransformers}`,
        version: null,
        binding: null,
        bindingExists: false,
        resolver: "bun",
        resolved: null,
      };
  const installedIndex = installedOrtIndex();
  const installedCopy = installedIndex
    ? loadOrtFrom(installedIndex, "require bun 安装目录里的绝对路径，不经过包名解析", installedIndex)
    : {
        ok: false,
        error: "node_modules/.bun 里没有 onnxruntime-node",
        version: null,
        binding: null,
        bindingExists: false,
        resolver: "installed-copy",
      };
  let bareError: string | null = null;
  try {
    const specifier: string = "onnxruntime-node";
    await import(specifier);
  } catch (error) {
    bareError = clip(errorText(error), 500);
  }
  const hooked = binaryExists ? installVendorResolver(binary) : null;
  const vendorAnchor = vendor ? vendorTransformers(vendor) : null;
  const vendorLoad = vendorAnchor && existsSync(vendorAnchor)
    ? loadOrtFrom(vendorAnchor, "createRequire(dist vendor transformers.node.mjs)。installVendorResolver(编译产物路径) 已调用，但仓库里的裸 import 会先命中普通 node 解析，钩子不会介入")
    : {
        ok: false,
        error: binaryExists ? "vendor 里没有 @huggingface/transformers" : "需先 bun run build:daemon",
        version: null,
        binding: null,
        bindingExists: false,
        resolver: "vendor",
      };
  const sandboxExec = Bun.which("sandbox-exec");
  const compiled = binaryExists
    ? await probeCompiledBinary({ binary, sandboxExec, home: homedir() })
    : {
        skipped: "需先 bun run build:daemon",
        exitCode: null,
        timedOut: false,
        classification: null,
        nativeCheck: null,
        stderr: "",
        cacheFiles: 0,
      };
  const modelPresent = existsSync(modelCache);
  const compiledOk = compiledBindingLoaded(compiled);
  const nameResolved = source.ok || bunResolveFromCore.ok || bunResolveFromTransformers.ok;
  const bunBindingOk = nameResolved || installedCopy.ok;
  const ok = nameResolved && vendorLoad.ok && compiledOk && !compiled.skipped;
  const notes = [
    "原生绑定可加载指 require 成功且 env.versions.node 有值。binding.js 在加载时 require() .node 文件，这就是 dlopen。没有创建 InferenceSession。",
    source.ok
      ? "transformers 的 createRequire 也能解析 onnxruntime-node。"
      : "源码里的 loadPackage 在没有 vendor 时会 import('@huggingface/transformers')。onnx-node.js 用 createRequire(import.meta.url) 再 require('onnxruntime-node')。这条 Node 解析从 transformers.node.mjs 出发找不到包。bun 把该依赖放在 node_modules/.bun，不放在父级 node_modules。",
    bunResolveFromTransformers.ok
      ? "Bun.resolveSync 从 transformers.node.mjs 能找到 onnxruntime-node。bun 自己的解析和 Node createRequire 不是同一条路径。"
      : "Bun.resolveSync 从 transformers.node.mjs 也找不到 onnxruntime-node。",
    installedCopy.ok
      ? "node_modules/.bun 里的 onnxruntime-node 用绝对路径可以在 bun 进程里 dlopen。包名解析失败不等于这份二进制本身坏了。"
      : "node_modules/.bun 里的副本也没有加载成功。",
    modelPresent
      ? "Hugging Face 缓存里有 e5 目录。脚本仍未做端到端嵌入，避免读取或改写该缓存。"
      : "端到端嵌入需要模型，未验证。~/.cache/huggingface 没有 Xenova/multilingual-e5-small，未下载。",
    "YOU_BRAIN_VENDOR_DIR 由 apps/desktop 的 daemon.rs 设置，packages/core/src/native/resolver.ts 不读取它。编译产物靠 execPath 旁的 vendor，或 ../Resources/vendor。",
    "bun 里的 vendor 加载使用同一套解析，dlopen 发生在 bun 进程，不在 you-brain 编译进程里。编译进程的证据是沙箱中的 native-check：错误阶段为 embed 表示 sharp 已通过，且已进入会 import transformers/onnxruntime 的嵌入路径。",
    bareError
      ? `从 scripts/m0 裸 import("onnxruntime-node") 失败（脚本所在包没有这个依赖）：${bareError}`
      : "从 scripts/m0 裸 import(\"onnxruntime-node\") 也成功。",
    hooked
      ? `installVendorResolver 指向 ${hooked}`
      : "installVendorResolver 没有找到 vendor 目录",
  ];
  if (compiled.classification === "model-unavailable") {
    notes.push("编译进程的 native-check 已通过 sharp，并进入 embed。失败文本不是 dlopen 或 Cannot find module，而是沙箱断网后的下载错误，临时模型缓存没有文件。原生绑定已在编译进程里加载；端到端嵌入未验证。");
  }
  if (compiled.classification === "embedded") {
    notes.push("native-check 在临时缓存里完成了嵌入。请核对 cacheFiles，确认不是从网络下载的。");
  }
  if (compiled.cacheFiles > 0) {
    notes.push(`native-check 往临时模型缓存写了 ${compiled.cacheFiles} 个文件，脚本结束时已删除。`);
  }
  const code: 0 | 1 | 2 = !binaryExists
    ? 2
    : ok
      ? 0
      : bunBindingOk || vendorLoad.ok || compiledOk
        ? 1
        : 2;
  const result: M0Result = {
    item,
    ok,
    evidence: {
      source,
      bunResolveFromCore,
      bunResolveFromTransformers,
      installedCopy,
      vendor: vendorLoad,
      compiled,
      modelCache: { path: modelCache, present: modelPresent },
      binary,
    },
    notes,
  };
  emit(result, code);
}

try {
  await main();
} catch (error) {
  emit({ item, ok: false, evidence: { error: errorText(error) }, notes: [] }, 1);
}
