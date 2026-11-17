import { memo } from "react";

import { formatDateTime, type Language } from "../../lib/format.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";

export function RelativeTime({ iso }: { iso: string | null }) {
  const { language, timeZone } = useDaemon();
  return <RelativeTimeText iso={iso} language={language} timeZone={timeZone} />;
}

/** 不订阅 daemon 上下文的版本：长列表的每一行用它，daemon 推送时不必逐行重渲染。 */
export const RelativeTimeText = memo(function RelativeTimeText({
  iso,
  language,
  timeZone,
}: {
  iso: string | null;
  language: Language;
  timeZone: string;
}) {
  const label = useRelativeTime(iso, language, timeZone);
  const absolute = formatDateTime(iso, language, timeZone);
  return (
    <time dateTime={iso ?? undefined} title={absolute}>
      {label}
    </time>
  );
});
