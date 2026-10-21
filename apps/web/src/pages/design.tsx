import { useEffect, useRef, useState, type ReactNode } from "react";

import { Banner } from "../components/banner.js";
import { Button, IconButton } from "../components/button.js";
import { Card, CardHead, Section } from "../components/card.js";
import { Chip } from "../components/chip.js";
import { ConfirmDialog, Dialog } from "../components/dialog.js";
import { EmptyState } from "../components/empty.js";
import { Icon } from "../components/icons.js";
import { Input, SearchField, Textarea } from "../components/input.js";
import { Kbd } from "../components/kbd.js";
import { Menu } from "../components/menu.js";
import { PageHeader } from "../components/page.js";
import { Row } from "../components/row.js";
import { Segmented } from "../components/segmented.js";
import { Select, type SelectOption } from "../components/select.js";
import { ShowMore } from "../components/show-more.js";
import { Skeleton, SkeletonCard, SkeletonRow, SkeletonStat } from "../components/skeleton.js";
import { Spinner } from "../components/spinner.js";
import { StatBlock, StatGrid } from "../components/stat.js";
import { StatusCapsule } from "../components/status-capsule.js";
import { useToast, type ToastTone } from "../components/toast.js";
import { Toggle } from "../components/toggle.js";
import { Tooltip } from "../components/tooltip.js";
import { DeviceTile, ProviderTile, SourceTile } from "../components/tile.js";
import { readQuery } from "../lib/route.js";
import { useRoute } from "../router.js";

const SOURCES = ["claude-code", "codex", "grok-build", "cursor", "gemini-cli", "notebook"] as const;

const SELECT_OPTIONS: SelectOption[] = [
  { value: "claude-code", label: "Claude Code", group: "对话", icon: <SourceTile source="claude-code" size="sm" /> },
  { value: "codex", label: "Codex", group: "对话", icon: <SourceTile source="codex" size="sm" /> },
  { value: "grok-build", label: "Grok", group: "对话", icon: <SourceTile source="grok-build" size="sm" /> },
  { value: "cursor", label: "Cursor", group: "对话", icon: <SourceTile source="cursor" size="sm" /> },
  { value: "gemini-cli", label: "Gemini CLI", group: "对话", icon: <SourceTile source="gemini-cli" size="sm" /> },
  { value: "deepseek", label: "DeepSeek", group: "模型", icon: <ProviderTile provider="deepseek" label="DeepSeek" size="sm" /> },
  { value: "openai", label: "OpenAI", group: "模型", icon: <ProviderTile provider="openai" label="OpenAI" size="sm" /> },
  { value: "ollama", label: "Ollama", group: "模型", icon: <ProviderTile provider="ollama" label="Ollama" size="sm" /> },
  { value: "kimi", label: "Kimi", group: "模型", icon: <ProviderTile provider="kimi" label="Kimi" size="sm" /> },
  { value: "disabled", label: "不可用", group: "模型", disabled: true },
];

function show(part: string | null, id: string): boolean {
  return part === null || part === id;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="gallery-block">
      <p className="gallery-label">{title}</p>
      {children}
    </section>
  );
}

function Column({
  theme,
  part,
  onDialog,
  onConfirm,
  onToast,
}: {
  theme: "dark" | "light";
  part: string | null;
  onDialog: () => void;
  onConfirm: () => void;
  onToast: (tone: ToastTone) => void;
}) {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("today");
  const [source, setSource] = useState("claude-code");
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="gallery-col" data-theme={theme}>
      <h2>{theme === "dark" ? "深色" : "浅色"}</h2>
      {show(part, "1") ? (
        <>
          <Block title="字号">
            <p className="type-xl">页面标题 20</p>
            <p className="type-lg">区块标题 16</p>
            <p className="type-md">卡片标题 14</p>
            <p className="type-base">正文 13。中文多行的行高保持紧凑可读。</p>
            <p className="type-sm">次要说明 12</p>
            <p className="type-micro">分组标签 11</p>
            <p className="type-read">阅读正文 15。这一段用来看行距，中文不要挤成一行。</p>
            <p className="type-stat">128</p>
          </Block>
          <Block title="按钮">
            {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
              <div key={variant} className="gallery-row">
                <Button variant={variant}>{variant}</Button>
                <Button variant={variant} className="is-hover">悬停</Button>
                <Button variant={variant} className="is-active">按下</Button>
                <Button variant={variant} className="is-focus">焦点</Button>
                <Button variant={variant} disabled>禁用</Button>
                <Button variant={variant} loading>加载</Button>
              </div>
            ))}
            <div className="gallery-row">
              <Button variant="primary" icon={<Icon name="plus" />} size="sm">新建</Button>
              <IconButton label="刷新"><Icon name="refresh" /></IconButton>
              <button type="button" className="icon-btn is-hover" aria-label="悬停"><Icon name="settings" /></button>
              <button type="button" className="icon-btn is-focus" aria-label="焦点"><Icon name="search" /></button>
              <button type="button" className="icon-btn is-disabled" aria-label="禁用" disabled><Icon name="plus" /></button>
              <Spinner label="加载中" />
            </div>
          </Block>
        </>
      ) : null}
      {show(part, "2") ? (
        <>
          <Block title="输入">
            <Input label="名称" placeholder="默认" />
            <input className="field-control is-hover" defaultValue="悬停" aria-label="悬停" />
            <input className="field-control is-focus" defaultValue="焦点" aria-label="焦点" />
            <Input label="出错" error="名字不能为空" defaultValue=" " />
            <Input label="禁用" disabled placeholder="不可用" />
            <Input label="密钥" secret defaultValue="sk-demo" />
            <Input label="已保存" saved defaultValue="已写入钥匙串" />
            <Textarea label="备注" placeholder="多行" />
            <SearchField value="" onChange={() => undefined} placeholder="搜索会话…" kbd="⌘K" label="搜索" />
            <SearchField value="京都" onChange={() => undefined} placeholder="搜索" label="搜索" />
          </Block>
          <Block title="选择">
            <Select label="来源" value={source} onChange={setSource} options={SELECT_OPTIONS} searchable />
            <div className="gallery-float select-pop" style={{ marginTop: 8 }}>
              <div className="select-search">
                <input className="field-control" placeholder="搜索" aria-label="搜索选项" defaultValue="" />
              </div>
              <div className="select-group">对话</div>
              <button type="button" className="select-option is-active" role="option" aria-selected>
                <span className="check-slot"><Icon name="check" /></span>
                <SourceTile source="claude-code" size="sm" />
                <span>Claude Code</span>
              </button>
              <button type="button" className="select-option" role="option" aria-selected={false}>
                <span className="check-slot" />
                <SourceTile source="codex" size="sm" />
                <span>Codex</span>
              </button>
              <div className="select-group">模型</div>
              <button type="button" className="select-option" role="option" aria-selected={false} disabled>
                <span className="check-slot" />
                <span>不可用</span>
              </button>
            </div>
          </Block>
          <Block title="开关与分段">
            <Toggle checked={on} label="通知" onChange={setOn} />
            <Toggle checked={false} label="关闭" onChange={() => undefined} />
            <Toggle checked={false} label="禁用" disabled onChange={() => undefined} />
            <Segmented
              label="范围"
              value={seg}
              onChange={setSeg}
              options={[
                { value: "today", label: "今日", icon: <Icon name="calendar" size={14} /> },
                { value: "topics", label: "话题", icon: <Icon name="book" size={14} /> },
                { value: "search", label: "搜索", icon: <Icon name="search" size={14} /> },
              ]}
            />
          </Block>
        </>
      ) : null}
      {show(part, "3") ? (
        <>
          <Block title="芯片">
            <div className="gallery-row">
              <Chip>中性</Chip>
              <Chip tone="accent" dot>强调</Chip>
              <Chip tone="success">成功</Chip>
              <Chip tone="warn" icon={<Icon name="alert" />}>警告</Chip>
              <Chip tone="danger">危险</Chip>
              <Chip className="is-hover">悬停</Chip>
              <Chip disabled className="is-disabled" onClick={() => undefined}>禁用</Chip>
              <Chip tone="accent" pressed onClick={() => undefined}>按下</Chip>
            </div>
          </Block>
          <Block title="卡片、行、数字">
            <Section title="最近" hint="两行一行" actions={<Button size="sm" variant="ghost">更多</Button>}>
              <Card>
                <CardHead title="话题" hint="可点开" />
                <Row
                  icon={<SourceTile source="claude-code" />}
                  title="同步按设备分片：事件日志与用户锁"
                  subtitle="冲突时后写胜出，用户改过的状态不会被盖掉。"
                  meta="3 分钟前"
                  trailing={<Chip tone="accent">进行中</Chip>}
                  onClick={() => undefined}
                />
                <Row
                  icon={<DeviceTile kind="desktop" />}
                  title="可展开的一行"
                  subtitle="展开后才看到下面的说明。"
                  expandable
                  expanded={expanded}
                  onClick={() => setExpanded((value) => !value)}
                >
                  <p className="type-sm">这里是展开内容。</p>
                </Row>
              </Card>
            </Section>
            <StatGrid>
              <StatBlock value="128" label="文档" hint="索引" />
              <StatBlock value="0" label="待上传" zero />
              <StatBlock value="1.2k" label="SESSIONS" english compact />
            </StatGrid>
          </Block>
          <Block title="来源与设备">
            <div className="gallery-row">
              {SOURCES.map((sourceId) => (
                <SourceTile key={sourceId} source={sourceId} />
              ))}
              <ProviderTile provider="deepseek" label="DeepSeek" />
              <DeviceTile kind="desktop" />
              <DeviceTile kind="server" />
              <DeviceTile kind="virtual" />
            </div>
          </Block>
          <Block title="更多">
            <ShowMore items={["第一条", "第二条", "第三条"]} limit={2}>
              {(item) => <p key={item} className="type-base">{item}</p>}
            </ShowMore>
          </Block>
        </>
      ) : null}
      {show(part, "4") ? (
        <>
          <Block title="提示条">
            <Banner tone="info">索引正在更新，可以继续浏览。</Banner>
            <Banner tone="success">已保存。</Banner>
            <Banner tone="warn">有 2 项需要处理。</Banner>
            <Banner tone="danger" action={<Button size="sm">重试</Button>}>没能连上后台。</Banner>
          </Block>
          <Block title="空状态与骨架">
            <EmptyState
              title="今天还没有会话"
              description="采集开启后，新的对话会出现在这里。"
              action={<Button variant="primary">去设置</Button>}
              secondary={<Button variant="ghost">了解采集</Button>}
            />
            <EmptyState size="sm" title="没有匹配" description="换个词再试。" icon="search" />
            <SkeletonRow />
            <div className="gallery-row">
              <SkeletonStat />
              <Skeleton width={120} height={12} />
            </div>
            <SkeletonCard />
          </Block>
          <Block title="状态胶囊">
            <div className="gallery-row">
              <StatusCapsule kind="ok" label="运行正常" />
              <StatusCapsule kind="warn" label="2 项需要处理" />
              <StatusCapsule kind="sync-error" label="同步异常" />
              <StatusCapsule kind="refine-error" label="提炼出错" />
              <StatusCapsule kind="loading" label="同步中…" />
              <StatusCapsule kind="offline" label="后台未连接" />
              <span className="capsule warn is-hover"><span className="dot" /><span>悬停</span></span>
            </div>
          </Block>
          <Block title="浮层">
            <div className="gallery-row">
              <Kbd>⌘K</Kbd>
              <Kbd>esc</Kbd>
              <span className="tooltip is-inline"><span className="tooltip-row">刷新 <Kbd>⌘R</Kbd></span></span>
            </div>
            <div className="gallery-float" style={{ padding: 4 }}>
              <button type="button" className="menu-item is-active"><Icon name="refresh" /><span className="menu-label">刷新</span><span className="menu-kbd"><Kbd>⌘R</Kbd></span></button>
              <button type="button" className="menu-item"><Icon name="sun" /><span className="menu-label">浅色</span></button>
              <div className="menu-sep" />
              <button type="button" className="menu-item danger"><Icon name="trash" /><span className="menu-label">删除</span></button>
              <button type="button" className="menu-item" disabled><span className="menu-label">禁用</span></button>
            </div>
          </Block>
        </>
      ) : null}
      {show(part, "5") ? (
        <Block title="对话框与提示">
            <div className="dialog">
              <header className="dialog-head">
                <h2>确认</h2>
                <p>这会合并两个话题，之后可以再拆开。</p>
              </header>
              <footer className="dialog-foot">
                <Button variant="ghost">取消</Button>
                <Button variant="danger">合并</Button>
              </footer>
            </div>
            <div className="toast success">
              <span className="toast-icon"><Icon name="check-circle" /></span>
              <p className="toast-body">已开始同步</p>
            </div>
            <div className="gallery-row">
              <Button onClick={onDialog}>打开对话框</Button>
              <Button variant="danger" onClick={onConfirm}>确认框</Button>
              <Button variant="ghost" onClick={() => onToast("success")}>成功提示</Button>
              <Button variant="ghost" onClick={() => onToast("danger")}>失败提示</Button>
              <Menu
                label="更多"
                trigger={<Button variant="ghost" icon={<Icon name="more" />}>菜单</Button>}
                items={[
                  { id: "refresh", label: "刷新", icon: <Icon name="refresh" />, shortcut: "⌘R" },
                  { id: "sep", separator: true },
                  { id: "delete", label: "删除", icon: <Icon name="trash" />, danger: true },
                  { id: "nope", label: "禁用", disabled: true },
                ]}
              />
              <Tooltip content="刷新" shortcut="⌘R">
                <Button variant="ghost">提示</Button>
              </Tooltip>
            </div>
        </Block>
      ) : null}
    </div>
  );
}

export function DesignPage() {
  const { href } = useRoute();
  const { push } = useToast();
  const part = readQuery(href, "part");
  const solo = readQuery(href, "solo");
  const open = readQuery(href, "open");
  const [dialog, setDialog] = useState(open === "dialog");
  const [confirm, setConfirm] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toasted = useRef(false);
  useEffect(() => {
    if (open !== "toast" || toasted.current) return;
    toasted.current = true;
    push({ message: "已开始同步", tone: "success", duration: 60_000 });
  }, [open, push]);
  const themes: Array<"dark" | "light"> = solo === "light" ? ["light"] : solo === "dark" ? ["dark"] : ["dark", "light"];
  return (
    <div className="page">
      <PageHeader title="组件" description="深色与浅色并排，用来核对状态。这页不在导航里。" />
      <div className={themes.length === 1 ? "gallery solo" : "gallery"}>
        {themes.map((theme) => (
          <Column
            key={theme}
            theme={theme}
            part={part}
            onDialog={() => setDialog(true)}
            onConfirm={() => setConfirm(true)}
            onToast={(tone) => push({ message: tone === "danger" ? "没能刷新" : "已开始同步", tone, duration: 60_000 })}
          />
        ))}
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="合并话题"
        description="合并之后，会话会归到目标话题。可以再拆开。"
        footer={
          <>
            <Button variant="ghost" data-cancel="" onClick={() => setDialog(false)}>取消</Button>
            <Button variant="primary" onClick={() => setDialog(false)}>合并</Button>
          </>
        }
      />
      <ConfirmDialog
        open={confirm}
        title="删除这条结论？"
        description="删除后不会自动写回来。"
        confirmLabel="删除"
        cancelLabel="取消"
        tone="danger"
        loading={confirming}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirming(true);
          window.setTimeout(() => {
            setConfirming(false);
            setConfirm(false);
          }, 600);
        }}
      />
    </div>
  );
}
