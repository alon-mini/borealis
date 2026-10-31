import type { BookRuleset } from "../types";

/**
 * IM17 in the mock host: the importer's edition guess for a book, a port of `borealis_migrate::edition::source_edition`
 * (see that module for the rule).
 */
const PHB_2024_RELEASE = "20240917";
const BOTH_PAIRS: [string, string][] = [["2014", "2024"], ["2014", "5.5e"], ["2014", "5.5"], ["5e", "5.5e"], ["5e", "5.5"]];
const JOINS = [" and ", " & ", "&", " / ", "/", " + ", "+", " or "];
const BOTH_PHRASES = ["with both editions", "for both editions", "supports both editions", "both editions of d&d", "both editions of 5e"];
const USABLE_WITH = ["works with", "compatible with", "usable with", "for use with", "playable with", "supports"];
const NEGATIONS = ["not", "isn't", "incompatible", "without"];
const WORDS_2024 = ["2024", "5.5e", "d&d 5.5", "dnd 5.5", "5.5 edition", "5.5 rules", "one d&d"];
const PHRASES_2024 = ["5.5e", "d&d 5.5", "dnd 5.5", "5.5 edition", "5.5 rules", "one d&d", "2024 rules", "2024 edition", "2024 player's handbook", "2024 phb", "d&d 2024", "dnd 2024"];

const plain = (t: string): string =>
  t.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/’/g, "'").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** `phrase` in `text` as whole words (like `has_phrase`). */
function hasPhrase(text: string, phrase: string): boolean {
  for (let i = text.indexOf(phrase); i >= 0; i = text.indexOf(phrase, i + 1)) {
    const before = text[i - 1] ?? "";
    const after = text[i + phrase.length] ?? "";
    const after2 = text[i + phrase.length + 1] ?? "";
    if (/[a-z0-9.]/.test(before) || /[a-z0-9]/.test(after) || (after === "." && /\d/.test(after2))) continue;
    return true;
  }
  return false;
}

const anyOf = (t: string, phrases: string[]): boolean => phrases.some((p) => hasPhrase(t, p));
const says2014 = (t: string): boolean => hasPhrase(t, "2014");
const negated = (s: string): boolean => anyOf(s, NEGATIONS);
const sentences = (t: string): string[] => t.split(/(?<=[.!?])(?= |$)/).map((s) => s.trim()).filter(Boolean);

function sentenceNamesBoth(s: string): boolean {
  const pair = BOTH_PAIRS.some(([a, b]) => JOINS.some((j) => hasPhrase(s, `${a}${j}${b}`) || hasPhrase(s, `${b}${j}${a}`)));
  const usable = anyOf(s, USABLE_WITH) && says2014(s) && anyOf(s, WORDS_2024);
  return pair || usable || anyOf(s, BOTH_PHRASES);
}

const namesBoth = (t: string): boolean => sentences(t).some((s) => !negated(s) && sentenceNamesBoth(s));

/** The importer's rule, IM17. */
export function guessEdition(name: string, setters: Record<string, string>, description = ""): BookRuleset {
  if ((setters.information ?? "").replace("&amp;", "&").startsWith("D&D 5.5e")) return "dnd2024";
  const n = plain(name);
  const d = plain(description);
  if (namesBoth(n) || namesBoth(d)) return "any";
  const nameSays = anyOf(n, WORDS_2024) && !says2014(n);
  const descriptionSays = !says2014(d) && sentences(d).some((s) => !negated(s) && anyOf(s, PHRASES_2024));
  if (nameSays || (!says2014(n) && descriptionSays)) return "dnd2024";
  const release = /^\d{8}$/.test(setters.release ?? "") ? setters.release! : null;
  const official = (setters.official ?? "").toLowerCase() === "true";
  return official && release !== null && release >= PHB_2024_RELEASE ? "dnd2024" : "dnd2014";
}
