import { Segmented } from "../components/segmented.js";
import { useDaemon } from "../daemon-context.js";
import { prefs } from "../lib/prefs.js";
import { MEMORY_TAB_KEY } from "../lib/route.js";
import { useRoute } from "../router.js";

/**
 * 「记忆」入口下的分段：今日 / 话题册。点击时记住停留的分段，下次点顶部「记忆」直接回到这里。
 * 话题册的历史区（/topics/history）属于话题册，传 current="topics"。
 */
export function MemoryTabs({ current }: { current: "today" | "topics" }) {
  const { t } = useDaemon();
  const { navigate } = useRoute();
  return (
    <div className="memory-tabs">
      <Segmented
        label={t("navMemory")}
        value={current}
        options={[
          { value: "today", label: t("navToday") },
          { value: "topics", label: t("topicsBook") },
        ]}
        onChange={(value) => {
          if (value === current) return;
          const next = value === "topics" ? "topics" : "today";
          prefs.setItem(MEMORY_TAB_KEY, next);
          navigate(next === "topics" ? "/topics" : "/today");
        }}
      />
    </div>
  );
}
