/**
 * M0 第 2 项：sharp 在 Bun 与编译产物的 vendor 树里能否做内存图 resize/png。
 *
 * 前置条件：bun。不读用户数据，不启动 you-brain.app。
 * 编译进程证据与第 1 项相同：沙箱里跑 dist/daemon/<triple>/you-brain native-check。
 * 该命令只做 webp 往返，失败时不返回 sharp.versions；png 与 versions 来自 bun 里的
 * 源码依赖和 vendor 副本。没有「只加载 sharp」的子命令。
 *
 * 用法：bun scripts/m0/sharp-runtime.ts
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { compiledBindingLoaded, probeCompiledBinary } from "./compiled-probe.ts";
import { hostTriple, repoRoot } from "./layout.ts";
import { loadSharpFrom, sourceSharpAnchor } from "./native-load.ts";
import { emit, errorText, type M0Result } from "./result.ts";
import { resolveVendorEntry, vendorNodeModulesDir } from "../../packages/core/src/native/resolver.ts";

const item = "sharp-runtime";

const usageNotes = [
  "业务代码里 sharp 只用于 packages/core/src/capture/images.ts：把会话里的内嵌图转成 webp 再上传。",
  "packages/core/src/native/check.ts 的 native-check 用一张 1x1 PNG 做 webp 往返，作为编译产物自检。",
  "@huggingface/transformers 的 package.json 依赖 sharp，文本嵌入（feature-extraction）不解码图片。",
  "文本嵌入不需要 sharp。带图片的会话采集需要。备选方案（wasm 或 Tauri 处理图片）只影响图片，不影响 e5 文本向量。",
];

async function main(): Promise<void> {
  const binary = join(repoRoot, "dist/daemon", hostTriple(), "you-brain");
  const binaryExists = existsSync(binary);
  const vendor = binaryExists ? vendorNodeModulesDir(binary) : null;
  const source = await loadSharpFrom(sourceSharpAnchor, "sharp", "createRequire(packages/core/package.json)，core 直接依赖 sharp 0.34.5");
  const vendorEntry = vendor ? resolveVendorEntry(vendor, "sharp") : null;
  const vendorLoad = vendorEntry
    ? await loadSharpFrom(
        vendorEntry,
        vendorEntry,
        "createRequire(resolveVendorEntry(vendor, 'sharp'))(绝对入口)。与 loadPackage 相同，但是 bun 进程，不经过 YOU_BRAIN_VENDOR_DIR",
      )
    : {
        ok: false,
        error: binaryExists ? "vendor 里没有 sharp" : "需先 bun run build:daemon",
        versions: null,
        pngBytes: null,
        width: null,
        height: null,
        png: false,
        resolver: "vendor",
      };
  const compiled = binaryExists
    ? await probeCompiledBinary({ binary, sandboxExec: Bun.which("sandbox-exec"), home: homedir() })
    : {
        skipped: "需先 bun run build:daemon",
        exitCode: null,
        timedOut: false,
        classification: null,
        nativeCheck: null,
        stderr: "",
        cacheFiles: 0,
      };
  const sharpInBinary = compiled.classification === "model-unavailable" || compiled.classification === "embedded";
  const ok = source.ok && vendorLoad.ok && sharpInBinary && !compiled.skipped;
  const notes = [
    ...usageNotes,
    "native-check 先加载 sharp 并做 webp。错误文本以 embed: 开头说明 sharp 阶段已经返回。它不报告 sharp.versions，也不做 png。",
    compiledBindingLoaded(compiled)
      ? "编译进程里的 sharp 阶段已通过。"
      : "编译进程里的 sharp 阶段没有被证明通过。",
  ];
  const code: 0 | 1 | 2 = !binaryExists ? 2 : ok ? 0 : 1;
  const result: M0Result = {
    item,
    ok,
    evidence: { source, vendor: vendorLoad, compiled, binary },
    notes,
  };
  emit(result, code);
}

try {
  await main();
} catch (error) {
  emit({ item, ok: false, evidence: { error: errorText(error) }, notes: usageNotes }, 1);
}
