//! Edition of migrated Aurora content (finding A3 of `specs/handoffs/st3-diff.md`).
//!
//! Aurora has no edition field: its 2024 books are separate sources (`Player’s Handbook (2024)`)
//! whose spells carry the same class support tags as the 2014 ones, and Aurora relies on the user
//! switching sources on or off. Borealis keeps both editions loaded, so a converted element that
//! belongs to a 2024 source is tagged `dnd2024` here, deterministically (IM1), from the `Source`
//! elements of the same run. IM17 (2026-10-31, replacing IM14's name and date guess) decides a
//! source's edition:
//! - **2024** when its `information` setter starts with `D&D 5.5e` (the marker the AuroraLegacy
//!   core and partnered repositories put on every 2024 source), or its own name or description
//!   says it is 2024 rules and never names 2014: the name says `2024`, `5.5e`, `D&D 5.5`, `5.5
//!   edition`/`rules` or One D&D (a bare `5e` beside it is the game's name: `5e 2024`); a
//!   sentence of the description that is not negated (`not`, `isn't`, `incompatible`,
//!   `without`) says `5.5e`, One D&D, `2024 rules`/`edition`, `D&D 2024` or the 2024 Player's
//!   Handbook (a bare year there is often a date). `5.5` alone is a version number;
//! - **Both editions** (`any`: offered to 2014 and 2024 characters alike) when the name or a
//!   sentence of the description that is not negated names both editions: `2014 and 2024`,
//!   `2014/2024`, `5e/5.5e`, `5e & 5.5e`, `for both editions`, or "works / compatible / usable
//!   with" a 2014 and a 2024 edition;
//! - 2014 otherwise: never from a release date or a bare year such as 2025, and text that names
//!   both editions any other way (`Collected 2014-2024`, "For 2014 rules. A version for the 2024
//!   rules is coming.") makes no guess. Official books keep IM8: one released on or after the 2024
//!   Player's Handbook is 2024.
//!
//! The user can set any imported book's edition (2014, 2024 or Both) on the Sources page and in
//! the import preview (stored in the content preferences, applied when content loads; the
//! converted files are never rewritten). A file whose elements all belong to sources of one
//! non-2014 edition (helpers of source `Internal`, which is not a `Source` element, follow their
//! file) takes that edition; in a mixed file each element is tagged. Only a 2014 run is
//! re-tagged: `--ruleset dnd2024` already stamps 2024.

use borealis_content::{source_key, ContentFile, Element, Ruleset};
use std::collections::BTreeMap;

/// Release date (`YYYYMMDD`) of the 2024 Player's Handbook, the IM8 cutoff (official books).
const PHB_2024_RELEASE: &str = "20240917";
/// Start of the `information` setter of a 2024 source.
const MARKER_2024: &str = "D&D 5.5e";

fn is_release_date(d: &str) -> bool {
    d.len() == 8 && d.bytes().all(|b| b.is_ascii_digit())
}

/// "Both" pairs: a word for the 2014 edition joined to one for the 2024 edition (`2014/2024`,
/// `5e & 5.5e`). A bare `5e` pairs only with `5.5e`/`5.5`: next to `2024` it is the game's name
/// (`5e 2024`), not the 2014 edition.
const BOTH_PAIRS: [(&str, &str); 5] = [
    ("2014", "2024"),
    ("2014", "5.5e"),
    ("2014", "5.5"),
    ("5e", "5.5e"),
    ("5e", "5.5"),
];
/// What joins the two in a "both" pair.
const JOINS: [&str; 8] = [" and ", " & ", "&", " / ", "/", " + ", "+", " or "];
/// Phrases that present a book as for both editions.
const BOTH_PHRASES: [&str; 5] = [
    "with both editions",
    "for both editions",
    "supports both editions",
    "both editions of d&d",
    "both editions of 5e",
];
/// A sentence that says the book can be used with what it names (`Works with 5e (2014) and
/// 5.5e (2024)`).
const USABLE_WITH: [&str; 6] = [
    "works with",
    "compatible with",
    "usable with",
    "for use with",
    "playable with",
    "supports",
];
/// Words that turn a sentence around (`Not compatible with 5.5e`): it makes no guess.
const NEGATIONS: [&str; 4] = ["not", "isn't", "incompatible", "without"];
/// Words that make a name (or a "usable with" sentence) say 2024. `5.5` alone is a version
/// number, not an edition.
const WORDS_2024: [&str; 7] = [
    "2024",
    "5.5e",
    "d&d 5.5",
    "dnd 5.5",
    "5.5 edition",
    "5.5 rules",
    "one d&d",
];
/// Phrases that make a description say 2024 (a bare year there is often a date).
const PHRASES_2024: [&str; 12] = [
    "5.5e",
    "d&d 5.5",
    "dnd 5.5",
    "5.5 edition",
    "5.5 rules",
    "one d&d",
    "2024 rules",
    "2024 edition",
    "2024 player's handbook",
    "2024 phb",
    "d&d 2024",
    "dnd 2024",
];

/// Lower case, `&amp;` and typographic apostrophes folded, HTML tags and runs of white space
/// collapsed to one space.
fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_tag = false;
    for c in text.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if in_tag => {}
            _ => out.push(c),
        }
    }
    let out = out.replace("&amp;", "&").replace('’', "'").to_lowercase();
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `phrase` occurs in `text` as whole words: no letter, digit or `.` right before it, no letter
/// or digit right after it (and no `.` + digit, as in `5.55`).
fn has_phrase(text: &str, phrase: &str) -> bool {
    let bytes = text.as_bytes();
    text.match_indices(phrase).any(|(i, _)| {
        let before = i.checked_sub(1).map(|j| bytes[j]);
        let end = i + phrase.len();
        let after = bytes.get(end).copied();
        let after2 = bytes.get(end + 1).copied();
        let word = |b: u8| b.is_ascii_alphanumeric();
        !before.is_some_and(|b| word(b) || b == b'.')
            && !after.is_some_and(word)
            && !(after == Some(b'.') && after2.is_some_and(|b| b.is_ascii_digit()))
    })
}

/// The sentences of a text (split after `.`, `!` or `?` followed by a space or the end, so
/// `5.5e` stays whole).
fn sentences(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in bytes.iter().enumerate() {
        let end = matches!(b, b'.' | b'!' | b'?') && bytes.get(i + 1).is_none_or(|n| *n == b' ');
        if end {
            out.push(text[start..=i].trim());
            start = i + 1;
        }
    }
    if start < text.len() {
        out.push(text[start..].trim());
    }
    out.into_iter().filter(|s| !s.is_empty()).collect()
}

fn says_2014(text: &str) -> bool {
    has_phrase(text, "2014")
}

fn any_of(text: &str, phrases: &[&str]) -> bool {
    phrases.iter().any(|p| has_phrase(text, p))
}

/// The sentence says "not" (or `isn't`, `incompatible`, `without`) somewhere.
fn negated(sentence: &str) -> bool {
    any_of(sentence, &NEGATIONS)
}

/// A sentence explicitly names both editions: a "both" pair (`2014 and 2024`, `5e/5.5e`), a
/// "both editions" phrase, or it says it is usable with a 2014 and a 2024 edition.
fn sentence_names_both(s: &str) -> bool {
    let pair = BOTH_PAIRS.iter().any(|(a, b)| {
        JOINS
            .iter()
            .any(|j| has_phrase(s, &format!("{a}{j}{b}")) || has_phrase(s, &format!("{b}{j}{a}")))
    });
    let usable = any_of(s, &USABLE_WITH) && says_2014(s) && any_of(s, &WORDS_2024);
    pair || usable || any_of(s, &BOTH_PHRASES)
}

/// The text names both editions in a sentence that is not negated.
fn names_both(text: &str) -> bool {
    sentences(text)
        .into_iter()
        .any(|s| !negated(s) && sentence_names_both(s))
}

/// The name presents the book as 2024: it says 2024 / 5.5e / D&D 5.5 / One D&D and not 2014.
fn name_says_2024(name: &str) -> bool {
    any_of(name, &WORDS_2024) && !says_2014(name)
}

/// The description presents the book as 2024: a sentence that is not negated says 2024, and the
/// description never says 2014 (naming both editions any other way makes no guess).
fn description_says_2024(description: &str) -> bool {
    !says_2014(description)
        && sentences(description)
            .into_iter()
            .any(|s| !negated(s) && any_of(s, &PHRASES_2024))
}

/// IM17: the edition a `Source` element presents itself as (see the module docs): `Dnd2024`,
/// `Any` (Both editions) or `Dnd2014`.
#[must_use]
pub fn source_edition(source: &Element) -> Ruleset {
    let setter = |name: &str| source.setter_value(name).map(str::trim);
    let marked =
        setter("information").is_some_and(|v| v.replace("&amp;", "&").starts_with(MARKER_2024));
    if marked {
        return Ruleset::Dnd2024;
    }
    let name = plain(&source.name);
    let description = plain(&source.description);
    if names_both(&name) || names_both(&description) {
        return Ruleset::Any;
    }
    if name_says_2024(&name) || (!says_2014(&name) && description_says_2024(&description)) {
        return Ruleset::Dnd2024;
    }
    // IM8: an official book released on or after the 2024 Player's Handbook
    let official = setter("official").is_some_and(|v| v.eq_ignore_ascii_case("true"));
    let late = setter("release").is_some_and(|d| is_release_date(d) && d >= PHB_2024_RELEASE);
    if official && late {
        Ruleset::Dnd2024
    } else {
        Ruleset::Dnd2014
    }
}

/// True when a `Source` element is 2024 content ([`source_edition`]).
#[must_use]
pub fn is_2024_source(source: &Element) -> bool {
    source_edition(source) == Ruleset::Dnd2024
}

/// Every `Source` element of the run by name (and `alternative` name), with its edition.
fn source_editions(files: &[(String, ContentFile)]) -> BTreeMap<String, Ruleset> {
    let mut out = BTreeMap::new();
    for el in files
        .iter()
        .flat_map(|(_, f)| &f.elements)
        .filter(|e| e.ty == "Source")
    {
        let edition = source_edition(el);
        out.insert(source_key(&el.name), edition);
        for alt in el.setters.iter().filter(|s| s.name == "alternative") {
            out.insert(source_key(&alt.value), edition);
        }
    }
    out
}

/// The edition of an element's source, or `None` when its source is not a `Source` element of
/// the run (`Internal`, another pack).
fn element_edition(el: &Element, sources: &BTreeMap<String, Ruleset>) -> Option<Ruleset> {
    if el.ty == "Source" {
        return Some(source_edition(el));
    }
    sources.get(&source_key(&el.source)).copied()
}

/// Tag the 2024 and Both-editions content of a 2014 run. Returns the indices of the files that
/// changed.
pub fn tag_editions(files: &mut [(String, ContentFile)], run_ruleset: Ruleset) -> Vec<usize> {
    if run_ruleset != Ruleset::Dnd2014 {
        return Vec::new();
    }
    let sources = source_editions(files);
    if sources.values().all(|r| *r == Ruleset::Dnd2014) {
        return Vec::new();
    }
    let mut changed = Vec::new();
    for (i, (_, file)) in files.iter_mut().enumerate() {
        let kinds: Vec<Option<Ruleset>> = file
            .elements
            .iter()
            .map(|e| element_edition(e, &sources))
            .collect();
        let mut known: Vec<Ruleset> = kinds.iter().flatten().copied().collect();
        known.dedup();
        known.sort_by_key(|r| r.as_str());
        known.dedup();
        if known.iter().all(|r| *r == Ruleset::Dnd2014) {
            continue;
        }
        if let [only] = known[..] {
            file.ruleset = Some(only);
        } else {
            for (el, kind) in file.elements.iter_mut().zip(&kinds) {
                if let Some(k) = kind.filter(|k| *k != Ruleset::Dnd2014) {
                    el.ruleset = Some(k);
                }
            }
        }
        changed.push(i);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use borealis_content::Setter;

    fn source(name: &str, setters: &[(&str, &str)]) -> Element {
        let mut e = Element::new(format!("ID_SRC_{}", name.len()), name, "Source", "Core");
        e.setters = setters.iter().map(|(n, v)| Setter::new(*n, *v)).collect();
        e
    }

    fn el(id: &str, source: &str) -> Element {
        Element::new(id, id, "Spell", source)
    }

    fn file(elements: Vec<Element>) -> ContentFile {
        let mut f = ContentFile::new(elements);
        f.ruleset = Some(Ruleset::Dnd2014);
        f
    }

    #[test]
    fn marker_or_official_release_date_marks_2024() {
        assert!(is_2024_source(&source("A", &[("information", "D&D 5.5e")])));
        assert!(is_2024_source(&source(
            "B",
            &[("information", "D&amp;D 5.5e. Only SRD 5.2.1 content.")]
        )));
        assert!(is_2024_source(&source(
            "C",
            &[("official", "true"), ("release", "20240917")]
        )));
        // a day before the 2024 handbook, third-party, malformed date or no setters: 2014
        assert!(!is_2024_source(&source(
            "D",
            &[("official", "true"), ("release", "20240916")]
        )));
        // IM17: no guess from a third-party book's date
        assert!(!is_2024_source(&source(
            "E",
            &[("third-party", "true"), ("release", "20250613")]
        )));
        assert!(!is_2024_source(&source(
            "F",
            &[("official", "true"), ("release", "2025-01-01")]
        )));
        assert!(!is_2024_source(&source("G", &[])));
    }

    #[test]
    fn whole_file_of_a_2024_source_becomes_a_2024_file() {
        let new = source("Player’s Handbook (2024)", &[("information", "D&D 5.5e")]);
        let old = source(
            "Player’s Handbook",
            &[("official", "true"), ("release", "20140819")],
        );
        let mut files = vec![
            ("a/source.xml".into(), file(vec![new])),
            ("b/source.xml".into(), file(vec![old])),
            (
                "a/spells.xml".into(),
                file(vec![
                    el("NEW", "Player's Handbook (2024)"),
                    el("HELPER", "Internal"),
                ]),
            ),
            (
                "b/spells.xml".into(),
                file(vec![el("OLD", "Player’s Handbook")]),
            ),
            ("c.xml".into(), file(vec![el("HELPER2", "Internal")])),
        ];
        assert_eq!(tag_editions(&mut files, Ruleset::Dnd2014), vec![0, 2]);
        assert_eq!(files[0].1.ruleset, Some(Ruleset::Dnd2024));
        assert_eq!(files[1].1.ruleset, Some(Ruleset::Dnd2014));
        assert_eq!(files[2].1.ruleset, Some(Ruleset::Dnd2024));
        assert!(files[2].1.elements.iter().all(|e| e.ruleset.is_none()));
        assert_eq!(files[3].1.ruleset, Some(Ruleset::Dnd2014));
        assert_eq!(files[4].1.ruleset, Some(Ruleset::Dnd2014));
    }

    #[test]
    fn mixed_file_tags_only_its_2024_elements() {
        let mut alt = source(
            "Dungeon Master’s Guide (2024)",
            &[("information", "D&D 5.5e")],
        );
        alt.setters.push(Setter::new("alternative", "DMG 2024"));
        let old = source("Dungeon Master’s Guide", &[("official", "true")]);
        let mut files = vec![(
            "mixed.xml".into(),
            file(vec![
                alt,
                old,
                el("NEW", "DMG 2024"),
                el("OLD", "Dungeon Master’s Guide"),
                el("HELPER", "Internal"),
            ]),
        )];
        assert_eq!(tag_editions(&mut files, Ruleset::Dnd2014), vec![0]);
        let f = &files[0].1;
        assert_eq!(f.ruleset, Some(Ruleset::Dnd2014));
        let tags: Vec<_> = f.elements.iter().map(|e| e.ruleset).collect();
        let n = Some(Ruleset::Dnd2024);
        assert_eq!(tags, [n, None, n, None, None]);
    }

    #[test]
    fn a_2024_run_or_a_run_without_2024_sources_is_unchanged() {
        let new = source("New", &[("information", "D&D 5.5e")]);
        let mut files = vec![("a.xml".into(), file(vec![new, el("X", "New")]))];
        assert!(tag_editions(&mut files, Ruleset::Dnd2024).is_empty());
        // a late date and a name saying 2014: 2014
        let old = source("Old Book 2014", &[("release", "20260101")]);
        let mut files = vec![("b.xml".into(), file(vec![old, el("Y", "Old Book 2014")]))];
        assert!(tag_editions(&mut files, Ruleset::Dnd2014).is_empty());
        assert_eq!(files[0].1.ruleset, Some(Ruleset::Dnd2014));
    }

    fn described(name: &str, description: &str) -> Element {
        let mut e = source(name, &[]);
        e.description = description.to_string();
        e
    }

    /// IM17: a book is guessed 2024 only when it presents itself as 2024: the marker, or its own
    /// name or description saying 2024 / 5.5e / One D&D.
    #[test]
    fn im17_only_a_book_that_says_2024_is_guessed_2024() {
        let d24 = Ruleset::Dnd2024;
        assert_eq!(
            source_edition(&source("A", &[("information", "D&D 5.5e")])),
            d24
        );
        for name in [
            "Player’s Handbook (2024)",
            "Heroes of 2024",
            "Some Book for 5.5e",
            "One D&D Playtest Classes",
        ] {
            assert_eq!(source_edition(&source(name, &[])), d24, "{name}");
        }
        for text in [
            "<p>Classes for the 5.5e rules.</p>",
            "Written for One D&amp;D (2024).",
            "Uses the 2024 rules.",
            "Updated for the 2024 Player's Handbook.",
        ] {
            assert_eq!(source_edition(&described("Homebrew", text)), d24, "{text}");
        }
    }

    /// IM17: no guess from a release date or a bare year such as 2025 (official books keep IM8).
    #[test]
    fn im17_no_guess_from_a_date_or_a_bare_year() {
        let d14 = Ruleset::Dnd2014;
        let third = |name: &str, release: &str| {
            source(name, &[("third-party", "true"), ("release", release)])
        };
        for e in [
            third("Grim Hollow: Player's Guide (2025)", "20250115"),
            third("Later Homebrew", "20260101"),
            source("Guide 2026", &[]),
            source("Homebrew", &[("release", "20240917")]),
            described(
                "Homebrew",
                "Published in 2025. Copyright 2024 by its author.",
            ),
        ] {
            assert_eq!(source_edition(&e), d14, "{}", e.name);
        }
        let official = source(
            "Monster Manual (2025)",
            &[("official", "true"), ("release", "20250218")],
        );
        assert_eq!(
            source_edition(&official),
            Ruleset::Dnd2024,
            "IM8 stays for official books"
        );
    }

    /// IM17: a book that names both editions is guessed Both editions (`any`).
    #[test]
    fn im17_a_book_that_names_both_editions_is_guessed_both() {
        for name in [
            "Spellbook (2014 and 2024)",
            "Classes 2014/2024",
            "Feats 2024 & 2014",
            "Monsters for 5e/5.5e",
            "Gear 5e & 5.5e",
            "Options for 5e and 5.5e",
        ] {
            assert_eq!(source_edition(&source(name, &[])), Ruleset::Any, "{name}");
        }
        for text in [
            "Compatible with both editions.",
            "<p>Works with the 2014 and 2024 rules.</p>",
            "For 5e / 5.5e tables.",
        ] {
            assert_eq!(
                source_edition(&described("Homebrew", text)),
                Ruleset::Any,
                "{text}"
            );
        }
        // the marker says 2024 whatever the description
        let mut marked = described("Marked", "For 2014 and 2024 tables.");
        marked.setters.push(Setter::new("information", "D&D 5.5e"));
        assert_eq!(source_edition(&marked), Ruleset::Dnd2024);
    }

    /// IM17: the patterns are conservative.
    #[test]
    fn im17_patterns_have_no_false_positives() {
        for name in [
            "Homebrew v1.5.5",
            "Pack 15.5",
            "Rules 5.55",
            "Cyberpunk 2077 Conversion",
            "Tome of 1024 Spells",
            "Book 20245",
            "The Crooked Moon 2014",
            "Player Options (2014)",
            "Collected 2014-2024",
            "Years 2014 to 2024",
            "Ruins of 2014/2015",
            "2.5e and 5.5f",
            "Both Worlds Edition",
            "Arcane 25e/55e",
        ] {
            assert_eq!(
                source_edition(&source(name, &[])),
                Ruleset::Dnd2014,
                "{name}"
            );
        }
        for text in [
            "Last updated 2024.",
            "A 5e homebrew. Version 5.5.",
            "Both editions of this book sold out.",
        ] {
            assert_eq!(
                source_edition(&described("Homebrew", text)),
                Ruleset::Dnd2014,
                "{text}"
            );
        }
    }

    /// IM17: a Both book's file becomes an `any` file; a mixed file tags its elements.
    #[test]
    fn im17_a_both_books_content_is_tagged_any() {
        let both = source("Classes 2014/2024", &[]);
        let new = source("New (2024)", &[]);
        let mut files = vec![
            (
                "a.xml".into(),
                file(vec![
                    both,
                    el("X", "Classes 2014/2024"),
                    el("H", "Internal"),
                ]),
            ),
            (
                "b.xml".into(),
                file(vec![
                    new,
                    el("Y", "New (2024)"),
                    el("Z", "Classes 2014/2024"),
                ]),
            ),
        ];
        assert_eq!(tag_editions(&mut files, Ruleset::Dnd2014), vec![0, 1]);
        assert_eq!(files[0].1.ruleset, Some(Ruleset::Any));
        let tags: Vec<_> = files[1].1.elements.iter().map(|e| e.ruleset).collect();
        assert_eq!(
            tags,
            [
                Some(Ruleset::Dnd2024),
                Some(Ruleset::Dnd2024),
                Some(Ruleset::Any)
            ]
        );
    }

    /// Second review L1: the guess edge cases, kept conservative (the user can override any).
    #[test]
    fn im17_edge_cases_of_the_second_review() {
        let d14 = Ruleset::Dnd2014;
        let d24 = Ruleset::Dnd2024;
        let both = Ruleset::Any;
        // a bare `5e` next to 2024 does not name 2014
        for name in [
            "Heliana's Guide (5e 2024)",
            "Subclasses for D&D 5e (2024 rules)",
        ] {
            assert_eq!(source_edition(&source(name, &[])), d24, "{name}");
        }
        // `5.5` alone is a version, not an edition: 5.5e, D&D 5.5, 5.5 edition or 5.5 rules
        for name in ["Version 5.5 Classes", "Homebrew (5.5)"] {
            assert_eq!(source_edition(&source(name, &[])), d14, "{name}");
        }
        for name in [
            "Classes for D&D 5.5",
            "Feats (5.5 rules)",
            "The 5.5 Edition Companion",
        ] {
            assert_eq!(source_edition(&source(name, &[])), d24, "{name}");
        }
        // descriptions mirror the name rule
        for (text, want) in [
            ("Subclasses for D&D 5e, built on the 2024 rules.", d24),
            ("Works with 5e (2014) and 5.5e (2024).", both),
            ("Usable with the 2014 or the 2024 Player's Handbook.", both),
            (
                "For 2014 rules. A version for the 2024 rules is coming.",
                d14,
            ),
            ("Not compatible with 5.5e.", d14),
            ("This book isn't for the 2024 rules.", d14),
        ] {
            assert_eq!(source_edition(&described("Homebrew", text)), want, "{text}");
        }
        // a name that says 2014 keeps the book 2014 whatever the description says of 2024
        assert_eq!(
            source_edition(&described(
                "The Crooked Moon 2014",
                "Updated for the 2024 rules."
            )),
            d14
        );
    }
}
