import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { SearchHit } from "@you-brain/core/http/types.js";

import { useDaemon } from "../daemon-context.js";
import { formatRelative } from "../lib/format.js";
import { nextIndex, type ListKey } from "../lib/list-nav.js";
import { searchHref, settingsHref, topicHref } from "../lib/route.js";
import { useRoute } from "../router.js";
import { useTheme } from "../theme-context.js";
import { Dialog } from "./dialog.js";
import { Icon, type IconName } from "./icons.js";
import { SearchField } from "./input.js";
import { Kbd } from "./kbd.js";
import { SourceTile } from "./tile.js";
import { useToast } from "./toast.js";

interface PaletteItem {
  id: string;
  group: string;
  title: string;
  hint?: string;
  icon: ReactNode;
  excerpt?: string;
  aside?: string;
  run: () => void;
}

function matches(label: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return true;
  return label.toLocaleLowerCase().includes(needle);
}

function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (needle === "") return <>{text}</>;
  const index = text.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase());
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark>{text.slice(index, index + needle.length)}</mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export function CommandPalette({
  open,
  onClose,
  initialQuery = "",
}: {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
}) {
  const { client, language, timeZone, topics, t } = useDaemon();
  const { navigate } = useRoute();
  const { setChoice } = useTheme();
  const { push } = useToast();
  const [query, setQuery] = useState(initialQuery);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void client
        .search({ query: q, limit: 5 })
        .then((response) => {
          if (!cancelled) setHits(response.results.slice(0, 5));
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query, client]);

  const go = (href: string): void => {
    navigate(href);
    onClose();
  };

  const items = useMemo(() => {
    const list: PaletteItem[] = [];
    const q = query.trim();
    if (q.length >= 2) {
      // First row on purpose: Enter after typing should show the full result page, not
      // open whichever session happened to rank first.
      list.push({
        id: "search-all",
        group: t("cmdSessions"),
        title: t("cmdSearchAll", { query: q }),
        icon: <Icon name="search" />,
        run: () => go(searchHref(q)),
      });
      for (const hit of hits) {
        list.push({
          id: `hit-${hit.conversationId}`,
          group: t("cmdSessions"),
          title: hit.excerpt.split("\n")[0] ?? hit.excerpt,
          excerpt: hit.excerpt,
          aside: formatRelative(hit.updatedAt, language, timeZone),
          icon: <SourceTile source={hit.source} size="sm" />,
          run: () => go(searchHref(q)),
        });
      }
    } else if (q === "") {
      const recent = [...topics].sort((a, b) => (b.lastActive ?? "").localeCompare(a.lastActive ?? "")).slice(0, 3);
      for (const topic of recent) {
        list.push({
          id: `topic-${topic.topicId}`,
          group: t("cmdRecent"),
          title: topic.name,
          hint: topic.summary,
          icon: <Icon name="book" />,
          run: () => go(topicHref(topic.zone, topic.topicId)),
        });
      }
    }
    const jumps: Array<{ href: string; label: string; icon: IconName }> = [
      { href: "/today", label: t("navToday"), icon: "calendar" },
      { href: "/topics", label: t("topicsBook"), icon: "book" },
      { href: "/portrait", label: t("navPortrait"), icon: "user" },
      { href: "/search", label: t("navSearch"), icon: "search" },
      { href: "/devices", label: t("navDevices"), icon: "laptop" },
      { href: "/status", label: t("navStatus"), icon: "activity" },
      { href: settingsHref("account"), label: t("navSettings"), icon: "settings" },
    ];
    for (const jump of jumps) {
      if (!matches(jump.label, q)) continue;
      list.push({
        id: `jump-${jump.href}`,
        group: t("cmdJumps"),
        title: jump.label,
        icon: <Icon name={jump.icon} />,
        run: () => go(jump.href),
      });
    }
    if (q !== "") {
      const actions: Array<{ id: string; label: string; icon: IconName; run: () => void }> = [
        {
          id: "sync",
          label: t("cmdSync"),
          icon: "refresh",
          run: () => {
            void client
              .sync()
              .then(() => push({ message: t("syncStarted"), tone: "success" }))
              .catch(() => push({ message: t("syncFailed"), tone: "danger" }));
            onClose();
          },
        },
        {
          id: "refresh",
          label: t("reload"),
          icon: "refresh",
          run: () => {
            onClose();
            window.dispatchEvent(new CustomEvent("you-brain-refresh"));
          },
        },
        { id: "light", label: t("cmdThemeToLight"), icon: "sun", run: () => { setChoice("light"); onClose(); } },
        { id: "dark", label: t("cmdThemeToDark"), icon: "moon", run: () => { setChoice("dark"); onClose(); } },
        { id: "system", label: t("cmdThemeToSystem"), icon: "monitor", run: () => { setChoice("system"); onClose(); } },
      ];
      for (const action of actions) {
        if (!matches(action.label, q)) continue;
        list.push({
          id: action.id,
          group: t("cmdActions"),
          title: action.label,
          icon: <Icon name={action.icon} />,
          run: action.run,
        });
      }
    }
    return list;
    // go closes over navigate; listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, hits, topics, t, language, timeZone, client, navigate, onClose, push, setChoice]);

  useEffect(() => {
    setActive(0);
  }, [query, hits]);

  const onKey = (event: ReactKeyboardEvent): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive((index) => nextIndex(index, items.length, event.key as ListKey));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      item?.run();
    }
  };

  let lastGroup = "";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("openPalette")}
      size="lg"
      placement="top"
      className="palette-dialog"
    >
      <div className="palette" onKeyDown={onKey}>
        <div className="palette-search">
          <SearchField value={query} onChange={setQuery} placeholder={t("cmdPlaceholder")} label={t("cmdPlaceholder")} autoFocus />
        </div>
        <div className="palette-list" role="listbox" aria-label={t("openPalette")}>
          {items.length === 0 ? <p className="palette-empty">{t("cmdEmpty")}</p> : null}
          {items.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {header ? <div className="palette-group">{header}</div> : null}
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "palette-item is-active" : "palette-item"}
                  onMouseEnter={() => setActive(index)}
                  onClick={item.run}
                >
                  {item.icon}
                  <span className="palette-copy">
                    <strong>
                      <Highlight text={item.title} query={query} />
                    </strong>
                    {item.hint ? (
                      <small>
                        <Highlight text={item.hint} query={query} />
                      </small>
                    ) : null}
                  </span>
                  {item.aside ? <small>{item.aside}</small> : null}
                </button>
              </div>
            );
          })}
        </div>
      </div>
      <div className="palette-foot">
        <span>
          <Kbd>↑↓</Kbd> {t("kbdSelect")}
        </span>
        <span>
          <Kbd>↵</Kbd> {t("kbdOpen")}
        </span>
        <span>
          <Kbd>esc</Kbd> {t("kbdClose")}
        </span>
      </div>
    </Dialog>
  );
}
