/**
 * Which existing topics a piece of text is about, with no model involved. Chinese has
 * no word boundaries, so it is compared in overlapping pairs of characters; rare terms
 * count for more, so "GM2" beats "Claude" when deciding what two topics share.
 */

const TERMS = /[a-z0-9][a-z0-9._+-]*|\p{Script=Han}+/gu;
const NAME_WEIGHT = 3;
const ALIAS_WEIGHT = 2;
const DETAIL_WEIGHT = 1;

export function topicTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.normalize("NFKC").toLowerCase().matchAll(TERMS)) {
    const word = match[0];
    if (/^[a-z0-9]/u.test(word)) {
      if (word.length > 1) terms.push(word);
      continue;
    }
    const chars = Array.from(word);
    for (let index = 0; index < chars.length - 1; index += 1) {
      terms.push(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return terms;
}

export interface TopicText {
  topicId: string;
  name: string;
  aliases: readonly string[];
  summary?: string;
  /** Titles of its sessions. Most topics have no summary, so these carry the meaning. */
  recentTitles?: readonly string[];
}

export interface RankedTopic<T> {
  topic: T;
  score: number;
}

function addTerms(bag: Map<string, number>, text: string, weight: number): void {
  for (const term of topicTerms(text)) bag.set(term, (bag.get(term) ?? 0) + weight);
}

function topicBag(topic: TopicText): Map<string, number> {
  const bag = new Map<string, number>();
  addTerms(bag, topic.name, NAME_WEIGHT);
  for (const alias of topic.aliases) addTerms(bag, alias, ALIAS_WEIGHT);
  if (topic.summary) addTerms(bag, topic.summary, DETAIL_WEIGHT);
  for (const title of topic.recentTitles ?? []) addTerms(bag, title, DETAIL_WEIGHT);
  return bag;
}

/** Cosine similarity over rarity-weighted terms, best first. Topics sharing nothing are left out. */
export function rankTopicsByText<T extends TopicText>(
  topics: readonly T[],
  query: string,
): RankedTopic<T>[] {
  const bags = topics.map(topicBag);
  const documentCount = new Map<string, number>();
  for (const bag of bags) {
    for (const term of bag.keys()) documentCount.set(term, (documentCount.get(term) ?? 0) + 1);
  }
  const rarity = (term: string): number =>
    Math.log(1 + topics.length / (1 + (documentCount.get(term) ?? 0)));

  const queryTerms = new Map<string, number>();
  for (const term of topicTerms(query)) {
    // Terms no topic has cannot match and would only shrink every score.
    if (documentCount.has(term)) queryTerms.set(term, (queryTerms.get(term) ?? 0) + 1);
  }
  let queryNorm = 0;
  for (const [term, count] of queryTerms) {
    queryNorm += (Math.log(1 + count) * rarity(term)) ** 2;
  }
  if (queryNorm === 0) return [];
  queryNorm = Math.sqrt(queryNorm);

  const ranked: RankedTopic<T>[] = [];
  topics.forEach((topic, index) => {
    const bag = bags[index];
    if (!bag) return;
    let dot = 0;
    let norm = 0;
    for (const [term, weight] of bag) {
      const value = weight * rarity(term);
      norm += value * value;
      const count = queryTerms.get(term);
      if (count !== undefined) dot += value * Math.log(1 + count) * rarity(term);
    }
    if (dot > 0 && norm > 0) ranked.push({ topic, score: dot / (queryNorm * Math.sqrt(norm)) });
  });
  return ranked.sort(
    (left, right) =>
      right.score - left.score || (left.topic.topicId < right.topic.topicId ? -1 : 1),
  );
}

const TITLES_PER_TOPIC = 3;
const TITLE_CHARS = 30;

/** Each topic's latest distinct session titles, newest first. */
export function recentSessionTitles(
  sessions: readonly { topicId: string | null; title: string; refinedAt: string | null }[],
): Map<string, string[]> {
  const newest = [...sessions].sort((left, right) =>
    (right.refinedAt ?? "").localeCompare(left.refinedAt ?? ""),
  );
  const byTopic = new Map<string, string[]>();
  for (const session of newest) {
    if (session.topicId === null) continue;
    const title = Array.from(session.title.trim()).slice(0, TITLE_CHARS).join("");
    if (title === "") continue;
    const titles = byTopic.get(session.topicId) ?? [];
    if (titles.length >= TITLES_PER_TOPIC || titles.includes(title)) continue;
    titles.push(title);
    byTopic.set(session.topicId, titles);
  }
  return byTopic;
}
