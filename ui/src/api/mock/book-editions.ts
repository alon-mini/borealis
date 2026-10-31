import type { BookRuleset, ContentPack, PreviewBook } from "../types";
import { apiError } from "./errors";

/**
 * IM14/IM17 (GitHub #11) in the mock host: the importer's edition guess for a book and the user's stored choice per book (by
 * name, lower-cased, apostrophes folded, like `borealis_content::source_key`). The real backend re-tags the book's
 * elements when content loads; the mock only reports the edition.
 */
export const bookKey = (name: string): string => name.trim().replace(/’/g, "'").toLowerCase();

const PHB_2024_RELEASE = "20240917";
const NAMES_2014 = ["2014", "5e"];
const NAMES_2024 = ["2024", "5.5e", "5.5"];
const JOINS = [" and ", " & ", "&", " / ", "/", " + ", "+", " or "];
const BOTH_PHRASES = ["with both editions", "for both editions", "supports both editions", "both editions of d&d", "both editions of 5e"];
const PHRASES_2024 = ["5.5e", "one d&d", "2024 rules", "2024 edition", "2024 player's handbook", "2024 phb", "d&d 2024", "dnd 2024", "5.5 edition"];

const plain = (t: string): string =>
  t.replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/’/g, "'").toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/** `phrase` in `text` as whole words (like `has_phrase` in `borealis_migrate::edition`). */
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

const namesBoth = (t: string): boolean =>
  BOTH_PHRASES.some((p) => hasPhrase(t, p)) ||
  NAMES_2014.some((a) => NAMES_2024.some((b) => JOINS.some((j) => hasPhrase(t, `${a}${j}${b}`) || hasPhrase(t, `${b}${j}${a}`))));

/** The importer's rule, IM17 (`borealis_migrate::edition::source_edition`). */
export function guessEdition(name: string, setters: Record<string, string>, description = ""): BookRuleset {
  if ((setters.information ?? "").replace("&amp;", "&").startsWith("D&D 5.5e")) return "dnd2024";
  const n = plain(name);
  const d = plain(description);
  if (namesBoth(n) || namesBoth(d)) return "any";
  const nameSays = (NAMES_2024.some((w) => hasPhrase(n, w)) || hasPhrase(n, "one d&d")) && !NAMES_2014.some((w) => hasPhrase(n, w));
  if (nameSays || PHRASES_2024.some((p) => hasPhrase(d, p))) return "dnd2024";
  const release = /^\d{8}$/.test(setters.release ?? "") ? setters.release! : null;
  const official = (setters.official ?? "").toLowerCase() === "true";
  return official && release !== null && release >= PHB_2024_RELEASE ? "dnd2024" : "dnd2014";
}

/** The `Source` elements of some Aurora XML texts with the importer's edition for each, each name once. */
export function booksOf(texts: string[]): { name: string; detected: BookRuleset }[] {
  const out: { name: string; detected: BookRuleset }[] = [];
  for (const text of texts) {
    for (const m of text.matchAll(/<element\b([^>]*)>([\s\S]*?)<\/element>/g)) {
      const head = m[1] ?? "";
      if (!/\btype="Source"/.test(head)) continue;
      const name = /\bname="([^"]*)"/.exec(head)?.[1];
      if (!name || out.some((b) => bookKey(b.name) === bookKey(name))) continue;
      const setters: Record<string, string> = {};
      for (const s of (m[2] ?? "").matchAll(/<set name="([^"]+)"[^>]*>([^<]*)<\/set>/g)) setters[s[1]!.toLowerCase()] = s[2]!.trim();
      const description = /<description>([\s\S]*?)<\/description>/.exec(m[2] ?? "")?.[1] ?? "";
      out.push({ name, detected: guessEdition(name, setters, description) });
    }
  }
  return out;
}

/** The user's stored editions. */
export class MockBookEditions {
  private chosen = new Map<string, BookRuleset>();

  get(name: string): BookRuleset | undefined { return this.chosen.get(bookKey(name)); }

  set(name: string, edition: BookRuleset): void { this.chosen.set(bookKey(name), edition); }

  previewBooks(texts: string[]): PreviewBook[] {
    return booksOf(texts).map(({ name, detected }) => {
      const set = this.get(name);
      return { name, detected, edition: set ?? detected, setByUser: set !== undefined };
    });
  }

  /** A source row's edition fields. */
  fields(name: string, pack: ContentPack): { edition: BookRuleset | null; editionSetByUser: boolean; editionEditable: boolean } {
    const set = this.get(name);
    const own = pack.rulesets.length === 1 ? pack.rulesets[0]! : null;
    return { edition: set ?? own, editionSetByUser: set !== undefined, editionEditable: pack.kind !== "bundled" };
  }
}

/** The edition the user may set: 2014, 2024 or Both editions (IM17), only on imported books. */
export function checkSettable(editable: boolean | undefined, edition: BookRuleset): void {
  if (!isBookRuleset(edition)) throw apiError("invalid_argument", "A book is 2014 rules, 2024 rules or Both editions.");
  if (editable === undefined) throw apiError("not_found", "That book is not installed.");
  if (!editable) throw apiError("invalid_argument", "Bundled books keep their edition; only imported books can be set.");
}

export const isBookRuleset = (r: string): r is BookRuleset => r === "dnd2014" || r === "dnd2024" || r === "any";
