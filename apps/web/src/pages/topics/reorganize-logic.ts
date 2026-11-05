import type {
  TopicReorganizeGroup,
  TopicReorganizePlan,
  TopicReorganizeStatus,
} from "@you-brain/core/http/types.js";

export interface ReorganizeWatchOptions {
  read: () => Promise<TopicReorganizeStatus>;
  onStatus: (status: TopicReorganizeStatus) => void;
  /** The daemon stopped answering, so the state of the run is unknown. */
  onLost: () => void;
  intervalMs?: number;
  maxMisses?: number;
}

/**
 * Asks the daemon until the run ends, one request at a time. A dropped request costs
 * one tick here; it used to leave the dialog spinning with nothing to wake it.
 * Returns a function that stops watching.
 */
export function watchReorganize(options: ReorganizeWatchOptions): () => void {
  const intervalMs = options.intervalMs ?? 2_000;
  const maxMisses = options.maxMisses ?? 5;
  let stopped = false;
  let misses = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (): void => {
    timer = setTimeout(() => void tick(), intervalMs);
  };
  const tick = async (): Promise<void> => {
    let status: TopicReorganizeStatus;
    try {
      status = await options.read();
    } catch {
      if (stopped) return;
      misses += 1;
      if (misses >= maxMisses) options.onLost();
      else schedule();
      return;
    }
    if (stopped) return;
    misses = 0;
    options.onStatus(status);
    if (status.state === "queued" || status.state === "running") schedule();
  };

  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** `3:07`, or `1:02:07` past an hour. Reads the same in every language. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** Groups still accepted. A group is known by its survivor, which no other group can share. */
export function selectedGroups(
  plan: TopicReorganizePlan,
  declined: ReadonlySet<string>,
): TopicReorganizeGroup[] {
  return plan.groups.filter((group) => !declined.has(group.intoTopicId));
}

/** How many live topics are left if the accepted groups are applied. */
export function topicsAfter(plan: TopicReorganizePlan, declined: ReadonlySet<string>): number {
  const absorbed = selectedGroups(plan, declined).reduce(
    (sum, group) => sum + group.members.length - 1,
    0,
  );
  return plan.topicCount - absorbed;
}

export function toggled(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}
