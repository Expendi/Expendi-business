/** Up to two initials for an avatar: "Achieng' Odhiambo" → "AO", "brian" → "B". */
export function initialsOf(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word));
  const first = words[0]?.match(/\p{L}/u)?.[0] ?? "";
  const last =
    words.length > 1 ? (words[words.length - 1]?.match(/\p{L}/u)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}
