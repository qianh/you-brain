import { formatDateTime } from "../../lib/format.js";
import { useRelativeTime } from "../../components/use-relative-time.js";
import { useDaemon } from "../../daemon-context.js";

export function RelativeTime({ iso }: { iso: string | null }) {
  const { language, timeZone } = useDaemon();
  const label = useRelativeTime(iso, language, timeZone);
  const absolute = formatDateTime(iso, language, timeZone);
  return (
    <time dateTime={iso ?? undefined} title={absolute}>
      {label}
    </time>
  );
}
