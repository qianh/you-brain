// "You-Brain 设计" and "you brain设计" share a canonical name.
const NAME_NOISE = /[\s\p{P}]+/gu;

export function canonicalTopicName(name: string): string {
  return name.toLowerCase().replace(NAME_NOISE, "");
}
