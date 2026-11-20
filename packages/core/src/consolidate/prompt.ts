import {
  MERGE_SUGGESTIONS_JSON_SCHEMA,
  TOPIC_SUMMARY_JSON_SCHEMA,
  TWIN_CLAIMS_JSON_SCHEMA,
  TWIN_CODING_PROPOSALS_JSON_SCHEMA,
  TWIN_EDITS_JSON_SCHEMA,
  TWIN_EVAL_ANSWERS_JSON_SCHEMA,
  TWIN_EVAL_JUDGE_JSON_SCHEMA,
  TWIN_MONTHLY_JSON_SCHEMA,
  TWIN_PROBES_JSON_SCHEMA,
} from "./schema.js";
import { clipUnits, textUnits } from "./text.js";

export const TOPIC_SUMMARY_SYSTEM_PROMPT = `你是 you-brain 的话题沉淀器。根据这个话题当天的变化，重写话题概要和下一步。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. summary 用中文，不超过 200 字，把当天新的结论整合进现有概要，不要逐条罗列会话。
2. nextStep 用中文，不超过 80 字，写现在最值得做的一件事。没有明确下一步时输出空字符串。
3. 不要编造输入里没有的事实。
4. JSON 键名保持英文。`;

export const MERGE_SUGGESTIONS_SYSTEM_PROMPT = `你是 you-brain 的话题整理器。下面是活跃区和历史区的话题。只找出高度重复、看起来是同一件事的话题对，并给出合并建议。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. pairs 最多 5 对。没有高度重复的就输出空数组。
2. fromTopicId 和 intoTopicId 必须是输入里给出的 topicId，不能相同。
3. 不要重复同一对。
4. reason 用中文短句，不超过 80 字，说明为什么它们是同一件事。
5. JSON 键名保持英文。`;

export interface SummaryPromptSession {
  title: string;
  summary: string;
  conclusions: readonly string[];
}

export interface SummaryPromptInput {
  day: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  nextStep: string;
  sessions: readonly SummaryPromptSession[];
  openTodos: readonly string[];
}

export interface MergePromptTopic {
  topicId: string;
  name: string;
  aliases: readonly string[];
  summary: string;
  zone: "active" | "history";
}

const PROMPT_CLIP = 500;

function line(value: string): string {
  const text = clipUnits(value.replace(/[\r\n]+/gu, " ").trim(), PROMPT_CLIP);
  return text === "" ? "（无）" : text;
}

export function buildTopicSummaryPrompt(input: SummaryPromptInput): { system: string; user: string } {
  const aliases = input.aliases.length === 0 ? "（无）" : input.aliases.map(line).join("、");
  const sessions =
    input.sessions.length === 0
      ? "（无）"
      : input.sessions
          .map((session, index) => {
            const conclusions =
              session.conclusions.length === 0
                ? "（无）"
                : session.conclusions.map((item) => `- ${line(item)}`).join("\n");
            return [
              `### 会话 ${index + 1}`,
              `标题：${line(session.title)}`,
              `概要：${line(session.summary)}`,
              "新增结论：",
              conclusions,
            ].join("\n");
          })
          .join("\n\n");
  const todos =
    input.openTodos.length === 0
      ? "（无）"
      : input.openTodos.map((item) => `- ${line(item)}`).join("\n");
  const user = [
    `日期：${input.day}`,
    `话题：${line(input.name)}`,
    `别名：${aliases}`,
    `当前概要：${line(input.summary)}`,
    `当前下一步：${line(input.nextStep)}`,
    "",
    "## 最近会话",
    sessions,
    "",
    "## 开放待办",
    todos,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TOPIC_SUMMARY_JSON_SCHEMA),
  ].join("\n");
  return { system: TOPIC_SUMMARY_SYSTEM_PROMPT, user };
}

export function buildMergeSuggestionsPrompt(input: {
  day: string;
  topics: readonly MergePromptTopic[];
}): { system: string; user: string } {
  const topics =
    input.topics.length === 0
      ? "（无）"
      : input.topics
          .map((topic) => {
            const aliases = topic.aliases.length === 0 ? "（无）" : topic.aliases.map(line).join("、");
            return [
              `- topicId: ${topic.topicId}`,
              `  区域：${topic.zone === "active" ? "活跃" : "历史"}`,
              `  名称：${line(topic.name)}`,
              `  别名：${aliases}`,
              `  概要：${line(topic.summary)}`,
            ].join("\n");
          })
          .join("\n");
  const user = [
    `日期：${input.day}`,
    "## 话题",
    topics,
    "",
    "## 输出 JSON schema",
    JSON.stringify(MERGE_SUGGESTIONS_JSON_SCHEMA),
  ].join("\n");
  return { system: MERGE_SUGGESTIONS_SYSTEM_PROMPT, user };
}

const TWIN_LAYOUT = `三层分工（每条规则只能住在一层）：
- full 人格分身：只写换项目、换话题也成立的东西。固定 11 节：1 一句话 / 2 现在在做什么（工作重心和方向，写明年月）/ 3 价值排序（冲突时什么优先于什么，最多 5 条）/ 4 行为签名（遇到什么情境他会怎样，写清适用范围和触发条件，最多 12 条）/ 5 判断力地图（能深谈、会挑战、不熟要给步骤的领域）/ 6 情绪与信任（什么让他恼火，信任从哪来）/ 7 说话方式（真实原话样本最多 10 条）/ 8 合作说明（跨非编码任务也成立的沟通与协作期待；已在 coding 里的通用编码规则不得在此重复）/ 9 红线（最多 10 条，不放具体产品前端口径）/ 10 世界观与品味（标明探索性，不当指令）/ 11 生活（低权重）。
- coding 编码分身：会作为 AGENTS.md / CLAUDE.md 内联进各 CLI，只写所有代码仓库都通用、会改变编码助手行为的公约。固定四节：「## 行为与范围」「## 安全与授权」「## 验证与交付」「## 并行与指令优先级」。
- projects 项目决定：按「## 项目名」或「## 项目 · 子主题」分小节，只写该项目已锁定的口径和决定；每个项目的首个小节标题下一行可维护「> repos: 仓库目录名1, 仓库目录名2」。`;

const TWIN_CODING_STYLE = `编码分身（coding）的写法：它是可直接执行的 Agent 行为契约，严禁压成电报体大杂烩。
- 固定四节：「## 行为与范围」（最多 9 条）、「## 安全与授权」（最多 6 条）、「## 验证与交付」（最多 7 条）、「## 并行与指令优先级」（最多 6 条），整份不超过 26 条。
- 每条规则写成「- **短标题**：触发条件 + 具体做什么 / 不做什么」，一条只讲一个行为边界，不超过 180 字，最多 1 个分号。
- 不设全局「技术栈」槽位；禁止收录特定语言框架默认、公司配置中心或基建名词（如 Apollo、XXL-JOB、RAGFlow、宜搭、H1/H2）、单次技能流程（如自动合并分支或跳过钩子）、具体命令、模型 ID、设备和网络细节、只对某个项目成立的口径（一律下放 projects）。
- 「## 行为与范围」首条「项目口径」由程序维护，不要输出，也不要改写。`;

const TWIN_STANDARD = `质量标准（写入前由程序逐条检查，不达标整次不写）：
- 蒸馏，不是记账。只留跨任务反复成立、会改变助手行为的规则；一次性的决定、某天发生的事、解释和理由都不写。
- 一条规则一行：full 每行不超过 110 字（最多 2 个分号），coding 每行不超过 180 字（最多 1 个分号）。
- full 的小节固定为 11 个，顺序不变；条数上限：现在在做什么 6、价值排序 5、行为签名 12、判断力地图 6、情绪与信任 5、合作说明 16、红线 10、世界观与品味 10、生活 8，原话最多 10 条。
- 行为签名写成「在什么情境下，他会怎样」，写清触发条件（例如区分「方案未对齐需拷问时一问一答」与「方向明确准备执行时一次问齐依赖」）；特定交付格式（如 HTML 报告）必须写清适用场景。
- 价值排序写成「A 优先于 B」，只写真正会冲突的取舍。
- 「现在在做什么」写明年月，过期的方向直接改掉；只有这一节可以出现时间。其他地方不写「近期、最近、本周、今天、上次、这次」。
- 新主张和已有规则矛盾时，以日期晚的为准，原地改写或删掉被推翻的旧说法，严禁新旧相反的说法并存。
- 不写空话和形容：「至关重要」「值得注意的是」「非常重要」这类删掉。
- 同一件事只写一次：已经在 coding 里的工程规则不在 full 重复写；多条规则说的是一回事就合并。`;

const TWIN_WRITING = `${TWIN_STANDARD}

写法：
- 一条规则一句话，写成清晰指令或情境反应，不写来历和原因；完整的中文短句，不用自造缩写；专有名词和标识符保留英文。
- 正文禁止出现：版本说明、来源、样本数、证据 ID、「待确认」「不升格」「两条都有效」这类记账措辞；否定式身份事实（直接不写）；把用户举的例子写成规则；任何密钥、token、密码、手机号、邮箱、身份信息、主机名、IP、完整本机路径。`;

const TWIN_EDIT_FORMAT = `输出格式：
- 只输出需要改动的小节。edits 每项是 {layer, heading, text}：heading 是该小节在当前文件里的「## 」行原文；text 是改完后该小节的完整内容，从「## 」行开始，可以改标题；删除整节时 text 为空字符串；新增小节时 heading 写新小节的「## 」行。
- 不要输出文件开头的标题行、版本行和编码分身里「项目口径」那一条，这些由程序维护。
- bump：只改措辞或删重复为 patch，新增或改变规则为 minor，结构调整为 major。
- changelog 用中文短句列出改了什么，每条写明层和小节，最多 8 条。没有改动时 edits 和 changelog 都是空数组。
- JSON 键名保持英文。`;

export const TWIN_CLAIMS_SYSTEM_PROMPT = `你是 you-brain 的数字分身主张抽取器。从输入里抽出关于用户本人的主张：他是谁、看重什么、怎么想、怎么说话、要助手怎么做、编码习惯、某个项目里定下的口径。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. layer：
   - persona：换项目、换话题也成立的工作重心、价值取舍、遇到什么情境会怎样、擅长和不熟的领域、情绪和信任、说话方式、对助手的跨场景期待、红线、世界观、品味、生活。说话方式的真实原话可以原样作为一条 persona 主张，加引号。
   - coding：所有代码仓库都适用、与具体语言/公司基建无关、会改变编码助手行为的工程纪律；具体工具、技能内置流程（如特定提交脚本）、公司基建（如 Apollo、XXL-JOB）、模型 ID 和设备细节一律不算 coding。
   - project：只对某个系统、仓库、业务成立的口径与决定；project 填项目名，优先沿用输入里给出的已有项目名；若对话明确提到对应的代码仓库目录名（仅填裸仓库名如 legal-ai、dzg-ai-tools、you-brain，不带路径斜杠），填入 repo。
   - 一次性操作、单轮调试中间态、临时状态、设备和网络的琐碎细节、试用信号、定时脚本固定模板、他人或群聊的观点：不要输出。
2. 每条主张一句完整中文，写成带适用条件的指令或陈述，不写来历；专有名词和标识符保留英文。他在纠正助手或在几种做法里选一种时，把触发情境和他的选择都写清楚。
3. 不要把用户举的例子写成通用规则；不要输出否定式身份事实；不要输出任何密钥、token、密码、手机号、邮箱、主机名、IP、完整本机路径。
4. 同一意思只输出一条。没有主张时输出空数组。
5. JSON 键名保持英文。`;

const CLAIMS_FROM_SESSIONS = `输入是用户本人在 AI 会话里的发言。只看他自己说的话；粘贴进来的文档、日志、定时任务模板、别人的观点都不算。
confidence 严格按下面判定：
- persona 与 coding：只有用户明确说出跨会话永久生效词（「以后都 / 一律 / 必须 / 永远不要 / 记进全局规范」）才标 high；单次会话里对助手某步做法的普通纠偏一律标 low（靠后续跨天复现再升格，不得因为是纠偏就标 high）。
- project：用户明确拍板锁定该项目口径或纠正该项目做法标 high；试探、讨论未定案标 low。`;

const CLAIMS_FROM_LEGACY = `输入是旧版数字分身的一段原文，里面的规则都已经由用户确认过。
confidence：一律 high；只有标了待确认、试用、暂定的内容才是 low。版本说明、来源、证据 ID、样本数这类记账内容不要抽。尽量保留所有仍然成立的规则，不要因为看起来琐碎就丢掉项目口径。`;

export interface TwinClaimPromptInput {
  source: "sessions" | "legacy";
  projects: readonly string[];
  text: string;
}

export function buildTwinClaimsPrompt(input: TwinClaimPromptInput): { system: string; user: string } {
  const user = [
    input.source === "sessions" ? CLAIMS_FROM_SESSIONS : CLAIMS_FROM_LEGACY,
    "",
    "## 已有项目名",
    input.projects.length === 0 ? "（无）" : input.projects.join("、"),
    "",
    "## 输入",
    input.text.trim() === "" ? "（无）" : input.text,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_CLAIMS_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_CLAIMS_SYSTEM_PROMPT, user };
}

export const TWIN_MERGE_SYSTEM_PROMPT = `你是 you-brain 的数字分身维护者。把新主张和纠正合并进数字分身。目标是蒸馏：分身越短、越准越好。只输出一个 JSON 对象，不要 Markdown，不要解释。

${TWIN_LAYOUT}

合并规则：
1. 分流：换项目、换话题也成立的人格、价值、说话特征与跨场景协作 → full；所有代码仓库都适用的工程行为契约 → coding（注意：日常会话里的 coding 主张由独立提案通道处理，只有「未应用的纠正」指向 coding 或重建时才改 coding）；只对某个系统、仓库、业务成立 → projects 的对应小节；一次性操作、临时状态、设备和网络的琐碎细节、他人或群聊的观点、试用信号 → 丢弃。
2. 门槛：full 和 coding 只收高置信主张（confidence 为 high，或者同一意思在「待定主张」里出现在另一天），「未应用的纠正」一律视为高置信。其余低置信主张不写进任何层。
3. 一条规则只住一处：写之前在各层里搜同义说法；已经在 coding 里的工程规范禁止再写进 full；已有同义规则就原地改写那一句，删掉被取代的旧说法。原话样本是举例，不得重抄规则正文。
4. ${TWIN_WRITING}
   ${TWIN_CODING_STYLE}
5. 预算：full 小于 12288 字节，coding 小于 6144 字节，projects 每个小节小于 4096 字节。超预算时依次：合并同义规则、删掉例子和解释、把项目专属内容下放到 projects、删掉已被取代的说法。
6. 和本次主张、纠正无关的小节不要输出。

${TWIN_EDIT_FORMAT}`;

export const TWIN_CODING_PROPOSALS_SYSTEM_PROMPT = `你是 you-brain 的编码分身守门人。编码分身（coding.md）会常驻注入用户的全部编码 CLI，因此任何新增或修改都必须先生成「待确认提案」交用户审核，不能降低现有规则清晰度。只输出一个 JSON 对象，不要 Markdown，不要解释。

${TWIN_CODING_STYLE}

提案筛选与撰写规则：
1. 严格准入：只保留真正对**所有代码仓库通用**（无论 Python、TypeScript、Rust、Java 还是个人/公司项目都成立）、且在「当前编码分身」里**尚未覆盖**的行为契约。
2. 坚决丢弃（输出空数组或不输出该条）：
   - 已被当前编码分身某条规则覆盖或等价的意思（不要为了微调措辞提提案）；
   - 已在「已有待审提案」里出现过的意思；
   - 特定技能流程（如 git-commit-helper 跳过 hook、自动合并分支）、公司基础设施（Apollo、XXL-JOB、RAGFlow 等）、特定语言/框架选型、单项目口径、临时环境路径。
3. 提案格式：
   - section：从「## 行为与范围」「## 安全与授权」「## 验证与交付」「## 并行与指令优先级」四节中选最贴切的一节。
   - action：补充全新维度用 "add"；修正或扩展现有某条规则用 "replace"，并在 targetLine 原样填入被替换的那一行。
   - proposedLine：写成「- **短标题**：触发条件 + 具体做什么 / 不做什么」，一条一事，不超过 175 字，最多 1 个分号，不含记账词与敏感信息。
   - reason：用一句中文（不超过 60 字）向用户说明为什么建议加入或替换这条编码规则。
4. 宁缺毋滥，最多输出 6 条；没有够格的新规则时 proposals 输出空数组。JSON 键名保持英文。`;

export const TWIN_PROJECT_MERGE_SYSTEM_PROMPT = `你是 you-brain 的项目决定维护者。输入是当天有新决定或纠正的几个项目的「当前小节」与「新主张 / 纠正」。请更新这些项目的小节，确保项目口径准确、最新、无前后矛盾。只输出一个 JSON 对象，不要 Markdown，不要解释。

项目决定（projects）维护规则：
1. 只输出 layer 为 "projects" 的 edits，只处理输入里给出的目标项目，不要编造其他项目。
2. 淘汰过时与冲突口径（核心要求）：把新主张与该项目现有的全部子节逐条比对。凡是已被新决定推翻、替代、改方案的旧说法（例如旧数据源、已废弃的同步方式、已取消的开关或旧架构），必须原地删除或改写为最新口径，严禁同一项目下保留前后矛盾的两套说法！一次性排查过程和临时状态直接删掉。
3. 小节组织：
   - 标题格式为「## 项目名」或「## 项目名 · 子主题」，同一项目名保持一致前缀。
   - 单小节接近或超过 4096 字节时，按子主题拆成多个「## 项目名 · 子主题」，合并同义表述。
   - 仓库目录映射：若现有小节首行带有「> repos: ...」或输入的新主张带有 repo 仓库目录名，在该项目第一个小节标题正下方保留并合并「> repos: 仓库1, 仓库2」（仅写裸仓库目录名，不写路径斜杠）。
4. 写法：每条口径一行完整中文短句，直接写清定论或约束，不写日期流水账、不写记账词（待确认、样本数等）、不写任何密钥、IP、邮箱、手机号或完整本机路径。
5. ${TWIN_EDIT_FORMAT}`;

export interface TwinPromptClaim {
  layer: string;
  project: string;
  repo?: string;
  confidence: string;
  text: string;
  day?: string;
}

export interface TwinPromptCorrection {
  correctionId: string;
  variant: string;
  section: string;
  text: string;
}

export interface TwinMergePromptInput {
  day: string;
  docs: { full: string; coding: string; projects?: string };
  claims: readonly TwinPromptClaim[];
  pending: readonly TwinPromptClaim[];
  corrections: readonly TwinPromptCorrection[];
}

const TWIN_CLAIM_CLIP = 400;
const TWIN_SECTION_CLIP = 40;
const TWIN_CORRECTION_CLIP = 240;
/** Cap on claims plus corrections sent with one merge. */
export const TWIN_EVIDENCE_LIMIT = 12_000;
/** Cap on earlier pending claims shown for recurrence. */
export const TWIN_PENDING_LIMIT = 6_000;

export function buildTwinMergePrompt(input: TwinMergePromptInput): {
  system: string;
  user: string;
  includedCorrectionIds: string[];
} {
  const corrections = packCorrections(input.corrections, TWIN_EVIDENCE_LIMIT);
  const claimBudget = Math.max(0, TWIN_EVIDENCE_LIMIT - textUnits(corrections.text));
  const user = [
    `日期：${input.day}`,
    "",
    ...docBlock(input.docs),
    "## 新主张",
    packClaims(input.claims, claimBudget) || "（无）",
    "",
    "## 待定主张（之前几天的低置信主张）",
    packClaims(input.pending, TWIN_PENDING_LIMIT) || "（无）",
    "",
    "## 未应用的纠正",
    corrections.text === "" ? "（无）" : corrections.text,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_EDITS_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_MERGE_SYSTEM_PROMPT, user, includedCorrectionIds: corrections.ids };
}

export function buildTwinCodingProposalsPrompt(input: {
  day: string;
  coding: string;
  existingProposals: readonly { section: string; proposedLine: string }[];
  claims: readonly TwinPromptClaim[];
  pending: readonly TwinPromptClaim[];
}): { system: string; user: string } {
  const existing =
    input.existingProposals.length === 0
      ? "（无）"
      : input.existingProposals
          .map((item) => `- [${oneLine(item.section)}] ${clipUnits(oneLine(item.proposedLine), 200)}`)
          .join("\n");
  const user = [
    `日期：${input.day}`,
    "",
    "## 当前编码分身 coding",
    input.coding.trim() === "" ? "（空）" : input.coding,
    "",
    "## 已有待审提案",
    existing,
    "",
    "## 今日编码相关主张",
    packClaims(input.claims, TWIN_EVIDENCE_LIMIT) || "（无）",
    "",
    "## 之前几天的低置信编码主张（仅当与今日主张跨天复现同一规则时才采纳）",
    packClaims(input.pending, TWIN_PENDING_LIMIT) || "（无）",
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_CODING_PROPOSALS_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_CODING_PROPOSALS_SYSTEM_PROMPT, user };
}

export function buildTwinProjectMergePrompt(input: {
  day: string;
  targetProjectsText: string;
  claims: readonly TwinPromptClaim[];
  pending: readonly TwinPromptClaim[];
  corrections: readonly TwinPromptCorrection[];
}): {
  system: string;
  user: string;
  includedCorrectionIds: string[];
} {
  const corrections = packCorrections(input.corrections, TWIN_EVIDENCE_LIMIT);
  const claimBudget = Math.max(0, TWIN_EVIDENCE_LIMIT - textUnits(corrections.text));
  const user = [
    `日期：${input.day}`,
    "",
    "## 目标项目当前小节（仅限本次涉及的项目）",
    input.targetProjectsText.trim() === "" ? "（新建项目小节）" : input.targetProjectsText,
    "",
    "## 新项目主张",
    packClaims(input.claims, claimBudget) || "（无）",
    "",
    "## 之前几天的待定项目主张",
    packClaims(input.pending, TWIN_PENDING_LIMIT) || "（无）",
    "",
    "## 未应用的项目纠正",
    corrections.text === "" ? "（无）" : corrections.text,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_EDITS_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_PROJECT_MERGE_SYSTEM_PROMPT, user, includedCorrectionIds: corrections.ids };
}

export const TWIN_FIX_SYSTEM_PROMPT = `你是 you-brain 的数字分身维护者。下面的三层数字分身没有通过写入前检查。只处理列出的问题，不引入新内容。只输出一个 JSON 对象，不要 Markdown，不要解释。

${TWIN_LAYOUT}

超预算或违反格式标准时按下面的顺序修正：
1. 合并同义或重叠的规则，删掉被取代的旧说法。
2. 删掉例子、解释和理由，把过长句子拆成独立的一条一事短规则。
3. 只对某个项目、系统或公司基建成立的规则移到 projects 对应小节（同时输出 projects 的 edits）。
4. 仍然超预算，删掉最少触发、影响最小的细则。
需要修正的层，把改动小节按完整新内容输出；参考「各节字节数」先压最大的节，不要在思考中逐字精确计算 UTF-8 字节数，直接合并重复条目、删除过时口径并快速输出 JSON。没有问题的层不删仍然成立的规则。

${TWIN_WRITING}

${TWIN_CODING_STYLE}

${TWIN_EDIT_FORMAT}`;

export function buildTwinFixPrompt(input: {
  docs: { full: string; coding: string; projects: string };
  problems: readonly string[];
}): { system: string; user: string } {
  const sizes = [
    ...sectionSizes("full", input.docs.full),
    ...sectionSizes("coding", input.docs.coding),
    ...(input.docs.full.trim() === "" && input.docs.coding.trim() === ""
      ? sectionSizes("projects", input.docs.projects)
      : []),
  ];
  const user = [
    ...docBlock(input.docs),
    "## 各节字节数",
    ...sizes,
    "",
    "## 需要修正的问题",
    input.problems.map((problem) => `- ${problem}`).join("\n"),
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_EDITS_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_FIX_SYSTEM_PROMPT, user };
}

export const TWIN_PROBES_SYSTEM_PROMPT = `你是 you-brain 的数字分身评测出题人。输入是用户本人这一周在 AI 会话里的发言。找出他做出明确判断的地方：纠正助手、否决方案、在几种做法里选一种、提出验收标准，各写成一道情境题。只输出一个 JSON 对象，不要 Markdown，不要解释。

规则：
1. situation 写一个助手会遇到的具体情境：助手准备怎么做，或者已经做了什么。不要复述用户原话，不要透露答案。
2. expect 写用户在这个情境下的实际反应，一两句中文。
3. 只出能看出他这个人的题。一个不了解他、但做事靠谱的助手本来就会做对的情境不要出；要出的是他的做法和常见做法不同，或者几种做法都说得通、他明确选了其中一种的情境。
4. 只出换一个项目也会遇到的情境：去掉项目名、业务名词和只在该项目里成立的口径。只在某个项目里拍板过一次、离开那个项目就推不出来的具体决定不要出题。
5. layer：编码和工程上的做法是 coding，其余是 persona。
6. 已有题目里标了「没有区分度」的，上次评测时各组作答结果都一样；不要再出和它们同类的题。
7. 同一个意思只出一道，也不要和已有题目重复。不超过给定的题量，宁缺毋滥；没有合适的就输出空数组。
8. JSON 键名保持英文。`;

export function buildTwinProbesPrompt(input: {
  turns: string;
  existing: readonly { situation: string; flat?: string }[];
  limit: number;
}): { system: string; user: string } {
  const user = [
    "## 本周发言",
    input.turns.trim() === "" ? "（无）" : input.turns,
    "",
    "## 已有题目",
    input.existing.length === 0
      ? "（无）"
      : input.existing
          .map(
            (probe) =>
              `- ${clipUnits(oneLine(probe.situation), 120)}${probe.flat === undefined ? "" : "（没有区分度）"}`,
          )
          .join("\n"),
    "",
    "## 题量",
    `最多 ${input.limit} 道。`,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_PROBES_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_PROBES_SYSTEM_PROMPT, user };
}

export const TWIN_EVAL_ANSWER_SYSTEM_PROMPT = `你在扮演下面描述的这个人。只根据给出的描述，回答每个情境里他会怎么反应、会要求助手怎么做。每个回答一两句中文。只输出一个 JSON 对象，不要 Markdown，不要解释。JSON 键名保持英文。`;

export const TWIN_EVAL_BLANK_SYSTEM_PROMPT = `你在扮演一位正在用 AI 助手干活的用户。回答每个情境里他会怎么反应、会要求助手怎么做。每个回答一两句中文。只输出一个 JSON 对象，不要 Markdown，不要解释。JSON 键名保持英文。`;

/** The baseline profile: what any careful engineer would say about himself, with nothing from the twin. */
export const TWIN_EVAL_GENERIC_PERSONA =
  "一位在中国工作的资深全栈工程师，日常重度使用 AI 编码助手，重视技术正确性和交付质量。";

/** With no profile the model answers as an ordinary user, the plain-model baseline. */
export function buildTwinEvalAnswerPrompt(input: {
  profile: readonly { title: string; text: string }[];
  probes: readonly { id: string; situation: string }[];
}): { system: string; user: string } {
  const user = [
    ...input.profile.flatMap((part) => [`## ${part.title}`, part.text, ""]),
    "## 情境",
    input.probes.map((probe) => `- ${probe.id}：${oneLine(probe.situation)}`).join("\n"),
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_EVAL_ANSWERS_JSON_SCHEMA),
  ].join("\n");
  return {
    system: input.profile.length === 0 ? TWIN_EVAL_BLANK_SYSTEM_PROMPT : TWIN_EVAL_ANSWER_SYSTEM_PROMPT,
    user,
  };
}

export const TWIN_EVAL_JUDGE_SYSTEM_PROMPT = `你是数字分身评测的判分人。对照每个情境里用户的真实反应 expect，判断回答是否做出了同样的选择。只看决定和方向是否一致，不看措辞。只输出一个 JSON 对象，不要 Markdown，不要解释。JSON 键名保持英文。`;

export function buildTwinEvalJudgePrompt(input: {
  items: readonly { id: string; situation: string; expect: string; answer: string }[];
}): { system: string; user: string } {
  const user = [
    "## 题目与回答",
    input.items
      .map((item) =>
        [
          `### ${item.id}`,
          `情境：${oneLine(item.situation)}`,
          `真实反应：${oneLine(item.expect)}`,
          `回答：${oneLine(item.answer) || "（未作答）"}`,
        ].join("\n"),
      )
      .join("\n\n"),
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_EVAL_JUDGE_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_EVAL_JUDGE_SYSTEM_PROMPT, user };
}

export const TWIN_MONTHLY_SYSTEM_PROMPT = `你在对比同一个人「人格分身」一个月前后的两个版本。总结这一个月里新增、改变或删掉了哪些价值、规则和习惯，写成变化条目；措辞微调不算变化。评测得分的变化由调用方单独写，你不要提分数。每条一句话，最多 6 条，没有实质变化就输出空数组。只输出一个 JSON 对象，不要 Markdown，不要解释。JSON 键名保持英文。`;

export function buildTwinMonthlyPrompt(input: {
  before: string;
  after: string;
}): { system: string; user: string } {
  const user = [
    "## 一个月前",
    input.before.trim() === "" ? "（空）" : input.before,
    "",
    "## 现在",
    input.after.trim() === "" ? "（空）" : input.after,
    "",
    "## 输出 JSON schema",
    JSON.stringify(TWIN_MONTHLY_JSON_SCHEMA),
  ].join("\n");
  return { system: TWIN_MONTHLY_SYSTEM_PROMPT, user };
}

function sectionSizes(layer: string, text: string): string[] {
  return text
    .split(/^(?=## )/mu)
    .filter((piece) => piece.startsWith("## "))
    .map((piece) => `- ${layer} ${piece.split("\n", 1)[0]}：${Buffer.byteLength(piece, "utf8")} 字节`);
}

function docBlock(docs: { full: string; coding: string; projects?: string }): string[] {
  const lines = [
    "## 当前人格分身 full",
    docs.full.trim() === "" ? "（空）" : docs.full,
    "",
    "## 当前编码分身 coding",
    docs.coding.trim() === "" ? "（空）" : docs.coding,
    "",
  ];
  if (docs.projects !== undefined) {
    lines.push(
      "## 当前项目决定 projects",
      docs.projects.trim() === "" ? "（空）" : docs.projects,
      "",
    );
  }
  return lines;
}

function packClaims(claims: readonly TwinPromptClaim[], budget: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const claim of claims) {
    const repoTag = claim.repo ? ` repo:${claim.repo}` : "";
    const place = claim.layer === "project" ? `project:${claim.project}${repoTag}` : claim.layer;
    const day = claim.day ? ` ${claim.day}` : "";
    const line = `- [${place} ${claim.confidence}${day}] ${clipUnits(oneLine(claim.text), TWIN_CLAIM_CLIP)}`;
    const extra = textUnits(line) + (lines.length === 0 ? 0 : 1);
    if (used + extra > budget) break;
    lines.push(line);
    used += extra;
  }
  return lines.join("\n");
}

function packCorrections(
  corrections: readonly TwinPromptCorrection[],
  budget: number,
): { text: string; ids: string[] } {
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;
  for (const correction of corrections) {
    const line = [
      `- ${correction.correctionId}`,
      `  层：${oneLine(correction.variant)}`,
      `  位置：${clipUnits(oneLine(correction.section), TWIN_SECTION_CLIP)}`,
      `  内容：${clipUnits(oneLine(correction.text), TWIN_CORRECTION_CLIP)}`,
    ].join("\n");
    const extra = textUnits(line) + (lines.length === 0 ? 0 : 1);
    if (used + extra > budget) break;
    lines.push(line);
    ids.push(correction.correctionId);
    used += extra;
  }
  return { text: lines.join("\n"), ids };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").trim();
}
