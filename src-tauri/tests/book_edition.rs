//! GitHub #11 (IM15, IM14, C1) through the real command layer, with invented books shaped like the
//! reporter's (Grim Hollow: Player's Guide 2025 style, third-party, no `D&D 5.5e` marker; supports
//! tags with `:`, `ō` and `'`; a feature whose requirements name an element instead of an id).
//!
//! - IM15: the three selects offer their targets; only the requirements text stays a warning.
//! - IM14: an unmarked "(2025)" book is guessed 2024, so its homebrew class is offered to 2024
//!   characters. The user sets any imported book's edition on the Sources page or in the import
//!   preview; the choice is stored in the content preferences, survives re-import and restart, and
//!   never rewrites the imported files. A character that took a class before its book's edition
//!   changed keeps it (and its features' choices); new characters follow the book's edition.
//!   Re-importing without the preview never flips an installed book's edition silently.
//! - C1: a fresh character carries no notice about content it never touches; a held class with a
//!   broken select shows the problem on that choice.

mod contract_support;
mod homebrew;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use borealis_lib::content_packs::NullSink;
use borealis_lib::content_preview::{ImportFileInput, PreviewImportRequest};
use borealis_lib::dto::{CharacterSnapshot, Ruleset};
use borealis_lib::dto_ext::CompendiumQuery;
use borealis_lib::error::ErrorCode;
use homebrew::{book, App, GRIM, OLD};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn set_edition(app: &App, name: &str, edition: Ruleset) {
    let v = serde_json::to_value(
        app.state
            .set_source_edition(name, edition, &NullSink)
            .expect("set edition"),
    )
    .unwrap();
    let errors = app.contract.response("set_source_edition", &v);
    assert!(errors.is_empty(), "set_source_edition: {errors:?}");
}

fn digest(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut out = BTreeMap::new();
    for e in walk(dir) {
        out.insert(e.display().to_string(), std::fs::read(&e).unwrap());
    }
    out
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for e in std::fs::read_dir(dir).unwrap().flatten() {
        let p = e.path();
        if p.is_dir() {
            out.extend(walk(&p));
        } else {
            out.push(p);
        }
    }
    out
}

#[test]
fn a_marked_book_is_2024_and_its_class_is_offered_to_2024_characters() {
    let app = App::new();
    // IM17: the marker (or the book saying 2024) makes it 2024; its 2025 date alone does not
    // (book_edition_both.rs)
    let report = app.import(
        "grim.xml",
        &book(GRIM, "GTPG25", "Gravecaller", "20250115", true),
    );
    // IM15: the three supports parse; only the requirements naming an element stay a warning
    let invalid: Vec<String> = report["issues"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|i| i["code"] == "invalid_expression")
        .map(|i| i["message"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(invalid.len(), 2, "{invalid:?}");
    assert!(
        invalid.iter().any(|m| m.contains("requirements")),
        "{invalid:?}"
    );
    assert!(
        invalid.iter().any(|m| m.contains("Broken (Gift")),
        "{invalid:?}"
    );

    let src = app.source(GRIM);
    assert_eq!(src["edition"], "dnd2024", "{src}");
    assert_eq!(src["editionSetByUser"], false);
    assert_eq!(src["editionEditable"], true);
    // the bundled books are not editable
    assert_eq!(app.source("SRD 5.1")["editionEditable"], false);

    let s24 = app.hero(Ruleset::Dnd2024);
    assert!(app
        .offered(&s24, "Class")
        .contains(&"Gravecaller".to_string()));
    let s14 = app.hero(Ruleset::Dnd2014);
    assert!(!app
        .offered(&s14, "Class")
        .contains(&"Gravecaller".to_string()));

    // IM15: a 2024 Gravecaller is offered its features
    let s24 = app.pick_class(&s24, "ID_GTPG25_CLASS");
    assert_eq!(
        app.offered(&s24, "Companion Boost"),
        ["Boost Dexterity", "Boost Strength"]
    );
    assert_eq!(app.offered(&s24, "Spirit Bond"), ["Ethereal Bond"]);
    assert_eq!(app.offered(&s24, "Spider Gift"), ["Web Walker"]);
}

#[test]
fn the_user_sets_a_books_edition_and_it_survives_restart_and_reimport_without_rewriting_files() {
    let app = App::new();
    let xml = book(OLD, "OTH", "Oldcaller", "20230101", false);
    app.import("old.xml", &xml);
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    let packs = app.data.join("library");
    let before = digest(&packs);

    set_edition(&app, OLD, Ruleset::Dnd2024);
    let src = app.source(OLD);
    assert_eq!(
        (src["edition"].clone(), src["editionSetByUser"].clone()),
        (json!("dnd2024"), json!(true))
    );
    let s24 = app.hero(Ruleset::Dnd2024);
    assert!(app
        .offered(&s24, "Class")
        .contains(&"Oldcaller".to_string()));
    let s14 = app.hero(Ruleset::Dnd2014);
    assert!(!app
        .offered(&s14, "Class")
        .contains(&"Oldcaller".to_string()));
    // the book's content carries its new edition everywhere (the Compendium's edition filter)
    let compendium = |ruleset: &str| {
        let q: CompendiumQuery = serde_json::from_value(
            json!({"query": "", "sources": [OLD], "ruleset": ruleset, "limit": 100}),
        )
        .expect("query");
        app.state.search_compendium(&q).expect("compendium").total
    };
    assert!(compendium("dnd2024") > 0);
    assert_eq!(compendium("dnd2014"), 0);
    // stored as a content preference; the imported files are untouched
    assert_eq!(
        digest(&packs),
        before,
        "the imported pack must not be rewritten"
    );
    let prefs: Value = serde_json::from_str(
        &std::fs::read_to_string(app.data.join("content-prefs.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(prefs["sourceEditions"]["old test homebrew"], "dnd2024");

    // restart
    let app = app.restart();
    assert_eq!(app.source(OLD)["edition"], "dnd2024");
    // re-import the same book: the choice stays
    app.import("old.xml", &xml);
    assert_eq!(app.source(OLD)["edition"], "dnd2024");
    assert_eq!(app.source(OLD)["editionSetByUser"], true);

    // only imported books (Both editions is a valid choice since IM17)
    let err = app
        .state
        .set_source_edition("SRD 5.1", Ruleset::Dnd2024, &NullSink)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
    let err = app
        .state
        .set_source_edition("No Such Book", Ruleset::Dnd2024, &NullSink)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn a_character_keeps_its_class_when_its_books_edition_changes() {
    let app = App::new();
    app.import("old.xml", &book(OLD, "OTH", "Oldcaller", "20230101", false));
    let s14 = app.hero(Ruleset::Dnd2014);
    let s14 = app.pick_class(&s14, "ID_OTH_CLASS");
    let slot_id =
        |s: &CharacterSnapshot, t: &str| s.slots.iter().find(|x| x.title == t).unwrap().id.clone();
    let s14 = app
        .state
        .apply_selection(&s14.id, &slot_id(&s14, "Spider Gift"), "ID_OTH_CF_WEB")
        .expect("feature");
    app.state.save_character(&s14.id).expect("save");

    // the book becomes 2024: R4 says a 2014 character never takes a 2024 class, but this one
    // already has it and keeps it, with its feature
    set_edition(&app, OLD, Ruleset::Dnd2024);
    let app = app.restart();
    let reopened = app.state.load_character(&s14.id).expect("load");
    let v = app.checked("load_character", &reopened);
    let class = v["slots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["title"] == "Class")
        .unwrap()
        .clone();
    assert_eq!(class["chosen"]["id"], "ID_OTH_CLASS", "{class}");
    let gift = v["slots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["title"] == "Spider Gift")
        .unwrap()
        .clone();
    assert_eq!(gift["chosen"]["id"], "ID_OTH_CF_WEB");
    // its other choices still offer the book's features
    assert_eq!(
        app.offered(&reopened, "Companion Boost"),
        ["Boost Dexterity", "Boost Strength"]
    );
    // the compatibility report says why it was kept
    let report = app.state.get_compatibility_report(&s14.id).expect("report");
    let entry = report
        .entries
        .iter()
        .find(|e| e.element.id == "ID_OTH_CLASS")
        .expect("class in the report");
    assert!(
        entry.notes.iter().any(|n| n.starts_with("Kept:")),
        "{:?}",
        entry.notes
    );
    // new 2014 characters follow the book's edition
    let fresh = app.hero(Ruleset::Dnd2014);
    assert!(!app
        .offered(&fresh, "Class")
        .contains(&"Oldcaller".to_string()));

    // a 2024 character takes it now, then the book goes back to 2014: it keeps it too
    let s24 = app.pick_class(&app.hero(Ruleset::Dnd2024), "ID_OTH_CLASS");
    set_edition(&app, OLD, Ruleset::Dnd2014);
    let s24 = app.state.get_snapshot(&s24.id).expect("snapshot");
    let chosen = s24
        .slots
        .iter()
        .find(|s| s.title == "Class")
        .and_then(|s| s.chosen.clone());
    assert_eq!(chosen.map(|c| c.id), Some("ID_OTH_CLASS".to_string()));
    let s14 = app.state.get_snapshot(&s14.id).expect("snapshot");
    let chosen = s14
        .slots
        .iter()
        .find(|s| s.title == "Class")
        .and_then(|s| s.chosen.clone());
    assert_eq!(chosen.map(|c| c.id), Some("ID_OTH_CLASS".to_string()));
}

#[test]
fn the_import_preview_lists_each_books_edition_and_installs_the_chosen_ones() {
    let app = App::new();
    let files = vec![
        ImportFileInput {
            file_name: "grim.xml".into(),
            content_base64: STANDARD.encode(book(GRIM, "GTPG25", "Gravecaller", "20250115", false)),
        },
        ImportFileInput {
            file_name: "marked.xml".into(),
            content_base64: STANDARD.encode(book(
                "Marked Test Guide",
                "MTG",
                "Markcaller",
                "20230101",
                true,
            )),
        },
    ];
    let preview = app
        .state
        .preview_import_pack(&PreviewImportRequest {
            files,
            folder: None,
        })
        .expect("preview");
    let v = serde_json::to_value(&preview).unwrap();
    assert!(app.contract.response("preview_import_pack", &v).is_empty());
    assert_eq!(
        v["books"],
        json!([
            {"name": GRIM, "detected": "dnd2014", "edition": "dnd2014", "setByUser": false},
            {"name": "Marked Test Guide", "detected": "dnd2024", "edition": "dnd2024", "setByUser": false}
        ])
    );
    let chosen = BTreeMap::from([(GRIM.to_string(), Ruleset::Dnd2024)]);
    app.state
        .install_import_preview(&preview.preview_id, Some(&chosen), &NullSink)
        .expect("install");
    assert_eq!(app.source(GRIM)["edition"], "dnd2024");
    assert_eq!(app.source(GRIM)["editionSetByUser"], true);
    assert_eq!(app.source("Marked Test Guide")["edition"], "dnd2024");
    // a book that is not in the preview is refused
    let again = app
        .state
        .preview_import_pack(&PreviewImportRequest {
            files: vec![ImportFileInput {
                file_name: "old.xml".into(),
                content_base64: STANDARD.encode(book(OLD, "OTH", "Oldcaller", "20230101", false)),
            }],
            folder: None,
        })
        .expect("preview");
    let wrong = BTreeMap::from([(GRIM.to_string(), Ruleset::Dnd2024)]);
    let err = app
        .state
        .install_import_preview(&again.preview_id, Some(&wrong), &NullSink)
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidArgument);
}

#[test]
fn reimporting_never_flips_an_installed_books_edition_silently() {
    let app = App::new();
    app.import(
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", false),
    );
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    let s14 = app.pick_class(&app.hero(Ruleset::Dnd2014), "ID_OTH_CLASS");
    // the same pack again, now marked D&D 5.5e: detected 2024, but the installed book is kept 2014
    app.import(
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", true),
    );
    let src = app.source(OLD);
    assert_eq!(src["edition"], "dnd2014", "{src}");
    assert_eq!(
        src["editionSetByUser"], true,
        "kept as a stored choice the user can change"
    );
    let s14 = app.state.get_snapshot(&s14.id).expect("snapshot");
    assert!(s14
        .slots
        .iter()
        .any(|s| s.title == "Class" && s.chosen.is_some()));
}

#[test]
fn content_preferences_from_a_newer_app_load_and_keep_their_unknown_keys() {
    let app = App::new();
    app.import("old.xml", &book(OLD, "OTH", "Oldcaller", "20230101", false));
    let path = app.data.join("content-prefs.json");
    let mut prefs: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    prefs["sourceEditions"] = json!({"old test homebrew": "dnd2030", "someone else": "dnd2024"});
    prefs["futureSetting"] = json!({"x": 1});
    prefs["disabledPacks"] = json!(["srd-5.1-monsters"]);
    std::fs::write(&path, serde_json::to_string(&prefs).unwrap()).unwrap();
    let app = app.restart();
    // an unknown edition is ignored, the rest of the file still applies
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    assert!(app
        .state
        .list_packs()
        .unwrap()
        .iter()
        .any(|p| p.id == "srd-5.1-monsters" && !p.enabled));
    set_edition(&app, OLD, Ruleset::Dnd2024);
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["futureSetting"], json!({"x": 1}));
    assert_eq!(after["sourceEditions"]["someone else"], "dnd2024");
    assert_eq!(after["sourceEditions"]["old test homebrew"], "dnd2024");
}

fn preview_of(app: &App, file: &str, xml: &str) -> borealis_lib::content_preview::ImportPreview {
    app.state
        .preview_import_pack(&PreviewImportRequest {
            files: vec![ImportFileInput {
                file_name: file.into(),
                content_base64: STANDARD.encode(xml),
            }],
            folder: None,
        })
        .expect("preview")
}

fn stored_editions(app: &App) -> Value {
    let prefs: Value = serde_json::from_str(
        &std::fs::read_to_string(app.data.join("content-prefs.json")).unwrap_or_default(),
    )
    .unwrap_or(Value::Null);
    prefs["sourceEditions"].clone()
}

/// Review M2: re-importing an installed book whose guess changed, the preview shows the edition
/// that will be installed (the installed one), and installing without a change keeps it.
#[test]
fn the_preview_shows_the_installed_edition_and_installs_what_it_shows() {
    let app = App::new();
    app.import(
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", false),
    );
    let p = preview_of(
        &app,
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", true),
    );
    let v = serde_json::to_value(&p.books).unwrap();
    assert_eq!(
        v,
        json!([{"name": OLD, "detected": "dnd2024", "edition": "dnd2014", "setByUser": false}])
    );
    app.state
        .install_import_preview(&p.preview_id, None, &NullSink)
        .expect("install");
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    // choosing the new guess in the preview installs that
    let p = preview_of(
        &app,
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", true),
    );
    let chosen = BTreeMap::from([(OLD.to_string(), Ruleset::Dnd2024)]);
    app.state
        .install_import_preview(&p.preview_id, Some(&chosen), &NullSink)
        .expect("install");
    assert_eq!(app.source(OLD)["edition"], "dnd2024");
}

/// Review M3: an index update or re-import of a pack that is switched off keeps its books'
/// installed editions too (read from the pack on disk, not from the loaded content).
#[test]
fn reimporting_a_disabled_pack_keeps_its_books_edition() {
    let app = App::new();
    app.import(
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", false),
    );
    let pack = app
        .state
        .list_packs()
        .unwrap()
        .into_iter()
        .find(|p| p.source_ids.iter().any(|s| s == OLD))
        .expect("pack")
        .id;
    app.state
        .set_pack_enabled(&pack, false, &NullSink)
        .expect("switch off");
    app.import(
        "shifting.xml",
        &book(OLD, "OTH", "Oldcaller", "20230101", true),
    );
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    assert_eq!(stored_editions(&app)["old test homebrew"], "dnd2014");
}

/// Review L3: an install that fails stores none of the preview's edition choices.
#[test]
fn a_failed_install_keeps_no_preview_choice() {
    let app = App::new();
    let p = preview_of(
        &app,
        "grim.xml",
        &book(GRIM, "GTPG25", "Gravecaller", "20250115", false),
    );
    // break the staged pack so the install cannot load it
    let staged = std::fs::read_dir(&app.data)
        .unwrap()
        .flatten()
        .map(|e| e.path().join("out"))
        .find(|p| p.join("pack.json").is_file())
        .expect("staged pack");
    for f in walk(&staged).into_iter().filter(|f| {
        f.extension().is_some_and(|e| e == "json")
            && f.file_name().is_some_and(|n| n != "pack.json")
    }) {
        std::fs::write(&f, "{ not json").unwrap();
    }
    let chosen = BTreeMap::from([(GRIM.to_string(), Ruleset::Dnd2014)]);
    assert!(app
        .state
        .install_import_preview(&p.preview_id, Some(&chosen), &NullSink)
        .is_err());
    assert_eq!(
        stored_editions(&app),
        Value::Null,
        "no choice stored for a failed install"
    );
}

/// Review M4: a content settings file this version cannot read is kept as `.bak` before anything
/// overwrites it, and an edition value of another shape does not make the file unreadable.
#[test]
fn unreadable_content_settings_are_kept_and_odd_editions_tolerated() {
    let app = App::new();
    app.import("old.xml", &book(OLD, "OTH", "Oldcaller", "20230101", false));
    let path = app.data.join("content-prefs.json");
    let mut prefs: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    prefs["sourceEditions"] =
        json!({"old test homebrew": {"edition": "dnd2024", "by": "user"}, "x": 5});
    prefs["disabledPacks"] = json!(["srd-5.1-monsters"]);
    std::fs::write(&path, serde_json::to_string(&prefs).unwrap()).unwrap();
    let app = app.restart();
    assert!(app
        .state
        .list_packs()
        .unwrap()
        .iter()
        .any(|p| p.id == "srd-5.1-monsters" && !p.enabled));
    assert_eq!(app.source(OLD)["edition"], "dnd2014");
    set_edition(&app, OLD, Ruleset::Dnd2024);
    let after: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(after["sourceEditions"]["x"], 5, "an unknown value is kept");
    assert_eq!(after["disabledPacks"], json!(["srd-5.1-monsters"]));

    // a file that does not parse at all: kept as .bak before the next save
    std::fs::write(&path, "{\"disabledPacks\": 7, \"broken\": ").unwrap();
    let app = app.restart();
    set_edition(&app, OLD, Ruleset::Dnd2014);
    let bak = std::fs::read_to_string(path.with_extension("json.bak")).expect(".bak kept");
    assert_eq!(bak, "{\"disabledPacks\": 7, \"broken\": ");
}
