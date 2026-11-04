import type { TopicReorganizeGroup, TopicReorganizePlan } from "@you-brain/core/http/types.js";

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
