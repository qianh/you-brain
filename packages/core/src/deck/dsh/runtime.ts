import { existsSync } from "node:fs";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { LlmProvider } from "@you-brain/protocol";

import type { SearchProvider } from "../../auth/search-secrets.js";
import { SEARCH_KEY_ENV, readSearchActive } from "./search-config.js";
import { bundledDsh, type BundledDsh } from "./bundled.js";
import { DSH_LOGIN_PROVIDERS, DshLogin, type DshLoginProviderId, type DshLoginView } from "./login.js";
import { DshWeb, type DshWebState } from "./web.js";
import { locateNode, type LocatedNode } from "./node.js";
import { detectDshPlugins, renderDshPatch, type DshPluginStatus } from "./patch.js";

/** 开发布局下 sidecar 在仓库根的 sidecars/dsh-host；打包后用环境变量或配置指定。 */
export function defaultSidecarDir(): string {
  return fileURLToPath(new URL("../../../../../sidecars/dsh-host", import.meta.url));
}

export interface DshRuntimeOptions {
  dataDir: string;
  homeDir: string;
  env?: NodeJS.ProcessEnv | undefined;
  getApiKey?: ((provider: LlmProvider) => string | null | undefined | Promise<string | null | undefined>) | undefined;
  /** 第三方搜索服务（Exa）的 Key；有 Key 才给 dsh 挂对应的搜索 MCP。 */
  getSearchKey?: ((provider: SearchProvider) => string | null | undefined | Promise<string | null | undefined>) | undefined;
  sidecarDir?: string | undefined;
  /** 守护进程可执行文件路径，用来找随 App 打包的 DSH 运行时（缺省 process.execPath）。 */
  execPath?: string | undefined;
  /** 强制指定 node 路径（缺省自动找 ≥24.9 的）。 */
  nodePath?: string | undefined;
  /**
   * 让 dsh 挂载 you-brain 自己的 MCP（搜索、话题、今日、分身、知识库…）。
   * 缺省：打包版自动用守护进程自身（`<exe> mcp`），开发环境（可执行文件是 bun）不挂。
   */
  mcpLaunch?: { command: string; args: readonly string[] } | undefined;
  /** 测试注入。 */
  locateNodeImpl?: typeof locateNode;
  detectPluginsImpl?: typeof detectDshPlugins;
}

interface BaseStatus {
  at: number;
  node: LocatedNode | null;
  plugins: DshPluginStatus[];
  problem: string | null;
}

/** 设置里已有的供应商 Key → dsh 环境层凭据（pi-ai 与 DeepSeek 适配器读取的变量名）。 */
const WEB_KEY_ENV: ReadonlyArray<readonly [LlmProvider, string]> = [
  ["deepseek", "DEEPSEEK_API_KEY"],
  ["claude", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
];
const STATUS_TTL_MS = 60_000;
/** 启用的第三方搜索记在 `<数据目录>/deck/dsh/` 下这个文件里。 */
export const SEARCH_CONFIG_FILE = "search.json";
/** dsh 子进程只拿到这几个环境变量 + 密钥，不继承 daemon 的整个环境。 */
const FORWARDED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "SHELL",
  // 代理：fake-ip 模式下本机 DNS 解析到 198.18.x.x，dsh 的公网校验会拒绝；
  // 拿到代理变量后 dsh 改由代理解析域名，web_fetch 才能出网。
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

export class DshRuntime {
  readonly #options: DshRuntimeOptions;
  readonly #root: string;
  readonly #bundled: BundledDsh | null;
  #base: BaseStatus | null = null;
  #web: DshWeb | null = null;
  #login: DshLogin | null = null;

  constructor(options: DshRuntimeOptions) {
    this.#options = options;
    this.#root = join(options.dataDir, "deck", "dsh");
    this.#bundled = bundledDsh(options.execPath ?? process.execPath, options.env ?? process.env);
  }

  /**
   * sidecar 的位置，依次：构造参数 → 环境变量 → `<dataDir>/deck/dsh/sidecar`（安装版用：
   * 编译后的二进制里没有仓库目录，把宿主目录链接/放到这里）→ 开发布局下的仓库目录。
   */
  get sidecarDir(): string {
    const explicit = this.#options.sidecarDir ?? this.#options.env?.YOU_BRAIN_DSH_HOST_DIR;
    if (explicit !== undefined && explicit !== "") return explicit;
    // 随 App 打包的运行时优先（用户机器上没有 Node 24，也没有仓库）。
    if (this.#bundled !== null) return this.#bundled.sidecarDir;
    const installed = join(this.#root, "sidecar");
    return existsSync(join(installed, "login-oauth.mjs")) ? installed : defaultSidecarDir();
  }

  /** 前置条件：DSH 依赖已装、Node ≥24.9。缓存一分钟。 */
  async #baseStatus(force: boolean): Promise<BaseStatus> {
    const cached = this.#base;
    if (!force && cached && Date.now() - cached.at < STATUS_TTL_MS) return cached;
    const plugins = (this.#options.detectPluginsImpl ?? detectDshPlugins)({
      homeDir: this.#options.homeDir,
      sidecarDir: this.sidecarDir,
      ...(this.#options.env !== undefined ? { env: this.#options.env } : {}),
    });
    // 显式指定的 node 优先；其次随 App 打包的；最后才去用户机器上找。
    const nodeOverride = this.#options.nodePath ?? this.#bundled?.node;
    const node = await (this.#options.locateNodeImpl ?? locateNode)({
      homeDir: this.#options.homeDir,
      ...(this.#options.env !== undefined ? { env: this.#options.env } : {}),
      ...(nodeOverride !== undefined ? { override: nodeOverride } : {}),
    });
    let problem: string | null = null;
    if (!existsSync(join(this.sidecarDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"))) {
      problem = `DSH 宿主依赖未安装：在 ${this.sidecarDir} 用 Node 24 运行 npm install`;
    } else if (node === null) {
      problem = "找不到 Node ≥ 24.9（DSH 的运行要求）；请安装 Node 24，或设置 YOU_BRAIN_NODE24 指向它";
    }
    this.#base = { at: Date.now(), node, plugins, problem };
    return this.#base;
  }

  /**
   * 启动（或确认已在运行）嵌入指挥台页面的 dsh Web 界面。前置条件不满足时返回 error 状态；
   * 其余情况立即返回当前状态，页面轮询到 ready 即可。
   */
  async webState(retry = false): Promise<DshWebState> {
    if (this.#web !== null) return this.#web.ensureStarted(retry);
    const base = await this.#baseStatus(false);
    if (base.problem !== null || base.node === null) {
      return { state: "error", error: base.problem ?? "找不到 Node ≥ 24.9" };
    }
    const dshHome = join(this.#root, "home");
    await mkdir(join(this.#root, "work"), { recursive: true });
    await this.#linkProfileModules(dshHome, "web");
    const node = base.node;
    this.#web = new DshWeb({
      nodePath: node.path,
      binPath: join(this.sidecarDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
      cwd: join(this.#root, "work"),
      // DSH 的定时任务（自动化任务）只在它运行时触发：随 U-Brain 常驻，崩溃后自动拉起。
      keepAlive: { maxRestarts: 5, baseDelayMs: 2_000, stableMs: 60_000 },
      env: async () => {
        // YOU_BRAIN_DATA_DIR：u-brain-bridge 插件据此读 daemon.json，回调 daemon 的 GUI 桥接口。
        const env: Record<string, string> = { DSH_HOME: dshHome, YOU_BRAIN_DATA_DIR: this.#options.dataDir };
        const source = this.#options.env ?? process.env;
        for (const name of FORWARDED_ENV) {
          const value = source[name];
          if (value !== undefined && value !== "") env[name] = value;
        }
        // 设置里已有的供应商 Key 交给 dsh 做环境层凭据；订阅登录和其它设置在 dsh 界面里完成。
        for (const [provider, name] of WEB_KEY_ENV) {
          let key = "";
          try {
            key = (await this.#options.getApiKey?.(provider))?.trim() ?? "";
          } catch {
            // 钥匙串读不到就不给，dsh 界面里仍可自行配置。
          }
          if (key !== "") env[name] = key;
        }
        // 启用的第三方搜索的 Key 只走环境变量，不写进补丁文件。
        const search = await this.#activeSearch();
        if (search !== null) env[SEARCH_KEY_ENV[search.provider]] = search.key;
        return env;
      },
      patches: async () => {
        // 用订阅登录过的供应商（凭据库里有记录）都把路由挂进 dsh，界面里才选得到。
        const credentials = await readFile(join(dshHome, ".credentials.yaml"), "utf8").catch(() => "");
        const signedIn = DSH_LOGIN_PROVIDERS.filter((provider) => credentials.includes(`llm-pi-ai/${provider.id}:`));
        // 随 App 带的本地插件（GUI App 桥）。文件不在就不挂（比如精简过的开发环境）。
        const bridge = join(this.sidecarDir, "plugins", "u-brain-bridge.mjs");
        const searchPlugin = join(this.sidecarDir, "plugins", "u-brain-search.mjs");
        const text = renderDshPatch({
          plugins: base.plugins,
          mcp: this.#mcpLaunch(),
          webSearchProvider: (await this.#activeSearch())?.provider,
          piAiProviders: signedIn.length > 0 ? Object.fromEntries(signedIn.map((provider) => [provider.id, {}])) : null,
          localPlugins: [
            ...(existsSync(bridge) ? [{ id: "u-brain-bridge", path: bridge }] : []),
            // Exa / Tavily 搜索后端：只注册，选不选由上面的 webSearchProvider 决定。
            ...(existsSync(searchPlugin) ? [{ id: "u-brain-search", path: searchPlugin }] : []),
            // 设置页里的“订阅登录”区块（前端 + 宿主路由，是个带 dsh.client 声明的包，按包名加载）。
            ...(existsSync(join(this.sidecarDir, "node_modules", "u-brain-login", "package.json"))
              ? [{ id: "u-brain-login", path: "u-brain-login" }]
              : []),
          ],
          // 品牌换成 U-Brain：顶掉 web 档里的官方品牌包（行 id 是 dsh-web-app 的 ui-brand-official）。
          brandPlugin: existsSync(join(this.sidecarDir, "node_modules", "u-brain-brand", "package.json")) ? "u-brain-brand" : undefined,
        });
        const files: string[] = [];
        if (text !== "[]\n") {
          const generated = join(this.#root, "generated.web.patch.yml");
          await writeFile(generated, text, "utf8");
          files.push(generated);
        }
        const user = join(this.#root, "user.patch.yml");
        if (await readFile(user, "utf8").then(() => true, () => false)) files.push(user);
        return files;
      },
    });
    return this.#web.ensureStarted();
  }

  /**
   * 当前生效的第三方搜索：设置里启用了某个后端、且它的 Key 还在，才算；否则返回 null，dsh 仍走自带的 DeepSeek 搜索。
   * env 和补丁都从这里取，两边不会各说各话。
   */
  async #activeSearch(): Promise<{ provider: SearchProvider; key: string } | null> {
    const provider = await readSearchActive(join(this.#root, SEARCH_CONFIG_FILE));
    if (provider === null) return null;
    try {
      const key = (await this.#options.getSearchKey?.(provider))?.trim() ?? "";
      return key === "" ? null : { provider, key };
    } catch {
      return null;
    }
  }

  /** 搜索设置变了：重启 dsh，让它按新补丁和环境选搜索后端。dsh 没在运行就什么都不做。 */
  refreshSearch(): void {
    this.#web?.restart();
  }

  /** you-brain 自己的 MCP：显式配置优先；打包版用守护进程自身的 `mcp` 子命令。 */
  #mcpLaunch(): { command: string; args: readonly string[]; env: Record<string, string> } | undefined {
    const launch =
      this.#options.mcpLaunch ??
      (this.#bundled !== null ? { command: this.#options.execPath ?? process.execPath, args: ["mcp"] } : undefined);
    if (launch === undefined) return undefined;
    // 数据目录显式传给 MCP 子进程：它据此找本地库和 daemon.json。
    return { ...launch, env: { YOU_BRAIN_DATA_DIR: this.#options.dataDir } };
  }

  /** 订阅登录的状态（各供应商是否已登录、是否正在等授权）。 */
  async loginView(): Promise<DshLoginView[]> {
    return (await this.#loginManager()).view();
  }

  async loginAction(action: "start" | "cancel" | "logout", id: DshLoginProviderId): Promise<DshLoginView[]> {
    const login = await this.#loginManager();
    if (action === "start") login.start(id);
    else if (action === "cancel") login.cancel(id);
    else {
      await login.logout(id);
      this.#web?.restart();
    }
    return login.view();
  }

  async #loginManager(): Promise<DshLogin> {
    if (this.#login !== null) return this.#login;
    const base = await this.#baseStatus(false);
    if (base.problem !== null || base.node === null) throw new Error(base.problem ?? "找不到 Node ≥ 24.9");
    const dshHome = join(this.#root, "home");
    await mkdir(dshHome, { recursive: true });
    this.#login = new DshLogin({
      nodePath: base.node.path,
      script: join(this.sidecarDir, "login-oauth.mjs"),
      dshHome,
      env: () => {
        const env: Record<string, string> = {};
        const source = this.#options.env ?? process.env;
        for (const name of FORWARDED_ENV) {
          const value = source[name];
          if (value !== undefined && value !== "") env[name] = value;
        }
        return env;
      },
      onSignedIn: () => {
        // 登录成功：重启 dsh 界面，让它挂上新的模型路由。
        this.#web?.restart();
      },
    });
    return this.#login;
  }

  async close(): Promise<void> {
    this.#login?.stop();
    this.#login = null;
    this.#web?.stop();
    this.#web = null;
  }

  /**
   * dsh 从 `<home>/profiles/<档案名>/` 解析档案内插件；把它的 node_modules 指到 sidecar 的
   * 依赖目录，子代理包（claude-code / codex / acp）就能被找到。
   */
  async #linkProfileModules(dshHome: string, profile: string): Promise<void> {
    const profileDir = join(dshHome, "profiles", profile);
    await mkdir(profileDir, { recursive: true });
    const link = join(profileDir, "node_modules");
    const target = join(this.sidecarDir, "node_modules");
    await rm(link, { recursive: true, force: true });
    await symlink(target, link, "dir");
  }
}
