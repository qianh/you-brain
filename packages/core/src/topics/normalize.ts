// "You-Brain 设计" and "you brain设计" share a canonical name.
const NAME_NOISE = /[\s\p{P}]+/gu;

export function canonicalTopicName(name: string): string {
  return name.toLowerCase().replace(NAME_NOISE, "");
}

/** What a topic is about once the verb for this round of work is gone. */
const ACTION_SUFFIX =
  /(?:代码审查|测试|审查|评审|复核|修复|验证|冒烟|探针|检查|确认|讨论|方案|问题|调研|分析|对比|排查|优化|实现)$/u;
const MIN_STEM_UNITS = 4;

/**
 * "GM2港口目录接入评审" and "GM2港口目录接入" name the same thing. Returns null when too
 * little is left to tell topics apart ("代码审查" would otherwise match every review).
 */
export function topicStem(name: string): string | null {
  let stem = canonicalTopicName(name.normalize("NFKC"));
  while (true) {
    const next = stem.replace(ACTION_SUFFIX, "");
    if (next === stem) break;
    stem = next;
  }
  return Array.from(stem).length >= MIN_STEM_UNITS ? stem : null;
}
