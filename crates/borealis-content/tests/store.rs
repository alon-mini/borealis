//! Integration tests for the content store: load order, overrides, appends, packs.

use borealis_content::element::Append;
use borealis_content::file::{PackFile, PackFileKind, PackFormat};
use borealis_content::rules::{GrantRule, Rule};
use borealis_content::setter::Setter;
use borealis_content::{
    ContentError, ContentFile, ContentStoreBuilder, Element, IssueCode, PackManifest, PackOrigin,
    Ruleset, Severity, SourceRestriction,
};
use std::fs;

fn el(id: &str, ty: &str, source: &str) -> Element {
    Element::new(id, id, ty, source)
}

fn file(elements: Vec<Element>) -> ContentFile {
    ContentFile::new(elements)
}

#[test]
fn custom_files_replace_earlier_definitions_and_move_them_to_the_end() {
    let mut first = el("ID_A", "Spell", "Core");
    first.description = "old".into();
    let mut newer = el("ID_A", "Feat", "Homebrew");
    newer.description = "new".into();
    let store = ContentStoreBuilder::new()
        .add_file(
            "one.json",
            PackOrigin::Custom,
            file(vec![first, el("ID_B", "Spell", "Core")]),
        )
        .add_file("two.json", PackOrigin::Custom, file(vec![newer]))
        .build();
    let ids: Vec<_> = store.iter().map(|s| s.element.id.as_str()).collect();
    assert_eq!(ids, ["ID_B", "ID_A"]);
    assert_eq!(store.element("ID_A").unwrap().description, "new");
    assert_eq!(&*store.get("ID_A").unwrap().file, "two.json");
    let replaced: Vec<_> = store
        .diagnostics()
        .iter()
        .filter(|d| d.code == IssueCode::ElementReplaced)
        .collect();
    assert_eq!(replaced.len(), 1);
    assert!(replaced[0].message.contains("type changed"));
}

#[test]
fn core_files_keep_the_first_definition_and_report_an_error() {
    let mut a = el("ID_A", "Spell", "Core");
    a.description = "first".into();
    let mut b = el("ID_A", "Spell", "Core");
    b.description = "second".into();
    let store = ContentStoreBuilder::new()
        .add_file("a.json", PackOrigin::Core, file(vec![a]))
        .add_file("b.json", PackOrigin::Core, file(vec![b]))
        .build();
    assert_eq!(store.len(), 1);
    assert_eq!(store.element("ID_A").unwrap().description, "first");
    let diag = &store.diagnostics()[0];
    assert_eq!(diag.code, IssueCode::DuplicateId);
    assert_eq!(diag.severity, Severity::Error);
    assert_eq!(diag.file.as_deref(), Some("b.json"));
}

#[test]
fn duplicate_inside_one_custom_file_later_wins() {
    let mut a = el("ID_A", "Spell", "Core");
    a.description = "1".into();
    let mut b = el("ID_A", "Spell", "Core");
    b.description = "2".into();
    let store = ContentStoreBuilder::new()
        .add_file("x.json", PackOrigin::Custom, file(vec![a, b]))
        .build();
    assert_eq!(store.len(), 1);
    assert_eq!(store.element("ID_A").unwrap().description, "2");
}

#[test]
fn appends_apply_after_all_files_regardless_of_order() {
    let mut early = file(vec![]);
    early.appends.push(Append {
        id: "ID_T".into(),
        supports: vec!["Sorcerer".into()],
        setters: vec![Setter::new("keywords", "fire")],
        rules: vec![Rule::Grant(GrantRule {
            id: "ID_X".into(),
            ..GrantRule::default()
        })],
        ..Append::default()
    });
    early.appends.push(Append {
        id: "ID_GONE".into(),
        ..Append::default()
    });
    let mut target = el("ID_T", "Spell", "Core");
    target.supports = vec!["Wizard".into()];
    let store = ContentStoreBuilder::new()
        .add_file("early.json", PackOrigin::Custom, early)
        .add_file("late.json", PackOrigin::Custom, file(vec![target]))
        .build();
    let stored = store.get("ID_T").unwrap();
    assert!(stored.extended);
    assert_eq!(stored.element.supports, ["Wizard", "Sorcerer"]);
    assert_eq!(stored.appended_supports, ["Sorcerer"]);
    assert_eq!(stored.element.rules.len(), 1);
    assert_eq!(stored.element.setter_value("keywords"), Some("fire"));
    assert!(store.diagnostics().iter().any(
        |d| d.code == IssueCode::AppendTargetMissing && d.element.as_deref() == Some("ID_GONE")
    ));
    assert_eq!(store.with_tag("Sorcerer").count(), 1);
}

#[test]
fn ignored_files_are_skipped_and_file_ruleset_is_inherited() {
    let mut ignored = file(vec![el("ID_I", "Spell", "Core")]);
    ignored.ignore = Some(true);
    let mut modern = file(vec![el("ID_M", "Species", "SRD 5.2")]);
    modern.ruleset = Some(Ruleset::Dnd2024);
    let store = ContentStoreBuilder::new()
        .add_file("i.json", PackOrigin::Custom, ignored)
        .add_file("m.json", PackOrigin::Custom, modern)
        .build();
    assert!(store.element("ID_I").is_none());
    assert_eq!(
        store.element("ID_M").unwrap().ruleset,
        Some(Ruleset::Dnd2024)
    );
    assert_eq!(store.files(), ["m.json"]);
    assert!(store
        .diagnostics()
        .iter()
        .any(|d| d.code == IssueCode::FileSkipped));
}

#[test]
fn indexes_by_type_source_tag_and_restriction() {
    let mut fireball = el("ID_FB", "Spell", "Player’s Handbook");
    fireball.supports = vec!["Wizard".into(), "Sorcerer".into()];
    let mut sword = el("ID_SW", "Weapon", "System Reference Document");
    sword.supports = vec!["Wizard".into()];
    let source = el("ID_SRC", "Source", "Core");
    let mut src = source.clone();
    src.name = "System Reference Document".into();
    let store = ContentStoreBuilder::new()
        .add_file(
            "a.json",
            PackOrigin::Custom,
            file(vec![fireball, sword, src]),
        )
        .build();
    assert_eq!(store.by_type("Spell").count(), 1);
    assert_eq!(store.by_source("System Reference Document").count(), 1);
    assert_eq!(store.with_tag("Wizard").count(), 2);
    assert_eq!(store.type_counts()["Source"], 1);
    assert!(store.contains_id("ID_FB") && !store.contains_id("ID_NOPE"));
    assert_eq!(store.source_names().len(), 3);

    let r = SourceRestriction::excluding(["Player’s Handbook"]);
    assert_eq!(store.candidates("Spell", &r).count(), 0);
    assert_eq!(store.candidates("Weapon", &r).count(), 1);
    let restricted = store.restricted_ids(&r);
    assert!(restricted.contains("ID_FB") && restricted.len() == 1);
    let undefined: Vec<_> = store.undefined_sources().into_iter().collect();
    assert_eq!(undefined, ["Player’s Handbook"]);
}

fn write_pack(dir: &std::path::Path, origin: PackOrigin) {
    let mut f = file(vec![el("ID_P", "Spell", "Core")]);
    f.ruleset = None;
    fs::write(dir.join("a.json"), f.to_json_pretty().unwrap()).unwrap();
    let manifest = PackManifest {
        format: PackFormat,
        id: "demo".into(),
        name: "Demo".into(),
        version: "1.0.0".into(),
        origin,
        rulesets: vec![Ruleset::Dnd2014],
        license: None,
        attribution: None,
        description: None,
        files: vec![PackFile {
            path: "a.json".into(),
            kind: PackFileKind::Content,
        }],
    };
    fs::write(dir.join("pack.json"), manifest.to_json_pretty().unwrap()).unwrap();
}

#[test]
fn loads_pack_directories_and_stamps_the_single_ruleset() {
    let tmp = tempfile::tempdir().unwrap();
    write_pack(tmp.path(), PackOrigin::Core);
    let store = ContentStoreBuilder::new()
        .add_pack_dir(tmp.path())
        .unwrap()
        .build();
    assert_eq!(store.packs().len(), 1);
    assert_eq!(store.packs()[0].id, "demo");
    assert_eq!(store.get("ID_P").unwrap().origin, PackOrigin::Core);
    assert_eq!(
        store.element("ID_P").unwrap().ruleset,
        Some(Ruleset::Dnd2014)
    );
}

#[test]
fn manifest_paths_cannot_escape_the_pack_directory() {
    let tmp = tempfile::tempdir().unwrap();
    write_pack(tmp.path(), PackOrigin::Custom);
    let text = fs::read_to_string(tmp.path().join("pack.json")).unwrap();
    fs::write(
        tmp.path().join("pack.json"),
        text.replace("a.json", "../a.json"),
    )
    .unwrap();
    let err = ContentStoreBuilder::new()
        .add_pack_dir(tmp.path())
        .unwrap_err();
    assert!(matches!(err, ContentError::UnsafePath(_)));
}

#[test]
fn directory_loading_uses_load_order_and_skips_manifests_and_ignored_paths() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    for (rel, desc) in [
        ("homebrew/h.json", "homebrew"),
        ("core/c.json", "core"),
        ("custom/ignore/i.json", "ignored"),
    ] {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut e = el("ID_SAME", "Spell", "Core");
        e.description = desc.into();
        fs::write(path, file(vec![e]).to_json_pretty().unwrap()).unwrap();
    }
    fs::write(root.join("pack.json"), "{}").unwrap();
    fs::write(root.join("x.index.json"), "{}").unwrap();
    let store = ContentStoreBuilder::new()
        .add_dir(root, PackOrigin::Custom)
        .unwrap()
        .build();
    assert_eq!(store.element("ID_SAME").unwrap().description, "homebrew");
    assert_eq!(store.files(), ["core/c.json", "homebrew/h.json"]);
}

#[test]
fn json_errors_carry_the_file_path() {
    let tmp = tempfile::tempdir().unwrap();
    let path = tmp.path().join("bad.json");
    fs::write(
        &path,
        "{\"format\":\"borealis-content/1\",\"elements\":[{\"id\":1}]}",
    )
    .unwrap();
    let err = ContentStoreBuilder::new()
        .add_json_file(&path, PackOrigin::Custom)
        .unwrap_err();
    assert!(err.to_string().contains("bad.json"), "{err}");
    let missing =
        ContentStoreBuilder::new().add_json_file(&tmp.path().join("nope.json"), PackOrigin::Custom);
    assert!(matches!(missing.unwrap_err(), ContentError::Io { .. }));
}

#[test]
fn appended_supports_list_only_the_tags_appends_added() {
    let mut appends = file(vec![]);
    for tags in [vec!["Wizard", "Order"], vec!["Order", "Circle"]] {
        appends.appends.push(Append {
            id: "ID_T".into(),
            supports: tags.into_iter().map(String::from).collect(),
            ..Append::default()
        });
    }
    let mut target = el("ID_T", "Spell", "Core");
    target.supports = vec!["Wizard".into()];
    let mut plain = el("ID_U", "Spell", "Core");
    plain.supports = vec!["Wizard".into()];
    let store = ContentStoreBuilder::new()
        .add_file("t.json", PackOrigin::Core, file(vec![target, plain]))
        .add_file("a.json", PackOrigin::Custom, appends)
        .build();
    let stored = store.get("ID_T").unwrap();
    assert_eq!(stored.element.supports, ["Wizard", "Order", "Circle"]);
    assert_eq!(stored.appended_supports, ["Order", "Circle"]);
    assert!(store.get("ID_U").unwrap().appended_supports.is_empty());
}

/// IM14 (GitHub #11): the user's edition per imported book is applied when content loads. It
/// re-tags the book's elements (its `Source` element, elements naming the book or one of its
/// `alternative` names, and `Internal` helpers in files of only that book), never edition-neutral
/// (`any`) elements, never bundled (core-origin) files, and marks what it changed.
#[test]
fn a_book_edition_set_by_the_user_retags_its_elements_when_content_loads() {
    let mut book = el("ID_GT_SOURCE", "Source", "Core");
    book.name = "Grim Test: Player’s Guide (2025)".into();
    book.setters.push(Setter::new("alternative", "GTPG25"));
    let mut neutral = el("ID_GT_LANGUAGE", "Language", "GTPG25");
    neutral.ruleset = Some(Ruleset::Any);
    let mut grim = file(vec![
        book,
        el("ID_GT_CLASS", "Class", "Grim Test: Player's Guide (2025)"),
        el("ID_GT_ALT", "Feat", "GTPG25"),
        el("ID_GT_HELPER", "Grants", "Internal"),
        neutral,
    ]);
    grim.ruleset = Some(Ruleset::Dnd2014);
    let mut other = file(vec![
        el("ID_OTHER", "Feat", "Other Book"),
        el("ID_OTHER_HELPER", "Grants", "Internal"),
    ]);
    other.ruleset = Some(Ruleset::Dnd2014);
    let mut bundled = file(vec![el(
        "ID_CORE_FEAT",
        "Feat",
        "Grim Test: Player’s Guide (2025)",
    )]);
    bundled.ruleset = Some(Ruleset::Dnd2014);
    let editions = std::collections::BTreeMap::from([(
        borealis_content::source_key("Grim Test: Player's Guide (2025)"),
        Ruleset::Dnd2024,
    )]);
    let store = ContentStoreBuilder::new()
        .add_file("core.json", PackOrigin::Core, bundled)
        .add_file("grim.json", PackOrigin::Custom, grim)
        .add_file("other.json", PackOrigin::Custom, other)
        .with_source_editions(editions)
        .build();
    let ed = |id: &str| {
        let s = store.get(id).unwrap();
        (s.element.ruleset, s.user_edition_book.clone())
    };
    // the alternative name (GTPG25) and the helper resolve to the book's own key
    let book = borealis_content::source_key("Grim Test: Player's Guide (2025)");
    let set = (Some(Ruleset::Dnd2024), Some(book));
    for id in ["ID_GT_SOURCE", "ID_GT_CLASS", "ID_GT_ALT", "ID_GT_HELPER"] {
        assert_eq!(ed(id), set, "{id}");
    }
    assert_eq!(ed("ID_GT_LANGUAGE"), (Some(Ruleset::Any), None));
    assert_eq!(ed("ID_OTHER"), (Some(Ruleset::Dnd2014), None));
    assert_eq!(ed("ID_OTHER_HELPER"), (Some(Ruleset::Dnd2014), None));
    assert_eq!(ed("ID_CORE_FEAT"), (Some(Ruleset::Dnd2014), None));
    // without preferences nothing changes
    assert_eq!(
        borealis_content::source_key(" Player’s HANDBOOK "),
        "player's handbook"
    );
}

/// IM17: a book can be set to Both editions (`any`), and a book the importer tagged for Both
/// (its `Source` element is `any`) can be set back to one edition: then every element of the
/// book takes it, as the `any` tags came from the guess, not from edition-neutral content.
#[test]
fn a_book_set_to_both_editions_and_back_retags_its_elements() {
    let book = |id: &str, name: &str| {
        let mut b = el(id, "Source", "Core");
        b.name = name.into();
        b
    };
    let mut both = file(vec![
        book("ID_BB_SOURCE", "Classes 2014/2024"),
        el("ID_BB_CLASS", "Class", "Classes 2014/2024"),
        el("ID_BB_HELPER", "Grants", "Internal"),
    ]);
    both.ruleset = Some(Ruleset::Any);
    let mut old = file(vec![
        book("ID_OB_SOURCE", "Old Book"),
        el("ID_OB_CLASS", "Class", "Old Book"),
    ]);
    old.ruleset = Some(Ruleset::Dnd2014);
    let editions = std::collections::BTreeMap::from([
        (
            borealis_content::source_key("Classes 2014/2024"),
            Ruleset::Dnd2014,
        ),
        (borealis_content::source_key("Old Book"), Ruleset::Any),
    ]);
    let store = ContentStoreBuilder::new()
        .add_file("both.json", PackOrigin::Custom, both)
        .add_file("old.json", PackOrigin::Custom, old)
        .with_source_editions(editions)
        .build();
    let ruleset = |id: &str| store.get(id).unwrap().element.ruleset;
    for id in ["ID_BB_SOURCE", "ID_BB_CLASS", "ID_BB_HELPER"] {
        assert_eq!(ruleset(id), Some(Ruleset::Dnd2014), "{id}");
    }
    for id in ["ID_OB_SOURCE", "ID_OB_CLASS"] {
        assert_eq!(ruleset(id), Some(Ruleset::Any), "{id}");
    }
}
