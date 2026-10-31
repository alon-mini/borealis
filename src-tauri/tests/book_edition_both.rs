//! IM17 (GitHub #11) through the real command layer: a book is guessed 2024 only when it says so,
//! never from its date (the reporter's "Grim Hollow: Player's Guide (2025)" shape is 2014 now); a
//! book that names both editions is guessed Both editions, offered to 2014 and 2024 characters;
//! the user can set Both on any imported book (stored as "both") and set it back.

mod contract_support;
mod homebrew;
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use borealis_lib::content_packs::NullSink;
use borealis_lib::content_preview::{ImportFileInput, PreviewImportRequest};
use borealis_lib::dto::Ruleset;
use homebrew::{book, App, GRIM, OLD};
use serde_json::{json, Value};

const BOTH: &str = "Test Classes 2014/2024";

fn offers_class(app: &App, ruleset: Ruleset, class: &str) -> bool {
    let hero = app.hero(ruleset);
    app.offered(&hero, "Class").contains(&class.to_string())
}

fn stored(app: &App) -> Value {
    let text = std::fs::read_to_string(app.data.join("content-prefs.json")).unwrap_or_default();
    serde_json::from_str::<Value>(&text).unwrap_or(Value::Null)["sourceEditions"].clone()
}

#[test]
fn a_dated_book_without_an_edition_word_is_2014() {
    let app = App::new();
    app.import(
        "grim.xml",
        &book(GRIM, "GTPG25", "Gravecaller", "20250115", false),
    );
    assert_eq!(app.source(GRIM)["edition"], "dnd2014");
    assert!(offers_class(&app, Ruleset::Dnd2014, "Gravecaller"));
    assert!(!offers_class(&app, Ruleset::Dnd2024, "Gravecaller"));
}

#[test]
fn a_book_naming_both_editions_is_guessed_both_and_offered_to_both() {
    let app = App::new();
    let xml = book(BOTH, "BTH", "Bothwalker", "20250115", false);
    let preview = app
        .state
        .preview_import_pack(&PreviewImportRequest {
            files: vec![ImportFileInput {
                file_name: "both.xml".into(),
                content_base64: STANDARD.encode(&xml),
            }],
            folder: None,
        })
        .expect("preview");
    assert_eq!(
        serde_json::to_value(&preview.books).unwrap(),
        json!([{"name": BOTH, "detected": "any", "edition": "any", "setByUser": false}])
    );
    app.state
        .install_import_preview(&preview.preview_id, None, &NullSink)
        .expect("install");
    assert_eq!(app.source(BOTH)["edition"], "any");
    assert!(offers_class(&app, Ruleset::Dnd2014, "Bothwalker"));
    assert!(offers_class(&app, Ruleset::Dnd2024, "Bothwalker"));
    // set to one edition: only that edition's characters get it
    app.state
        .set_source_edition(BOTH, Ruleset::Dnd2024, &NullSink)
        .expect("set 2024");
    assert!(!offers_class(&app, Ruleset::Dnd2014, "Bothwalker"));
    assert!(offers_class(&app, Ruleset::Dnd2024, "Bothwalker"));
}

#[test]
fn the_user_sets_both_editions_on_a_2014_book_stored_as_both() {
    let app = App::new();
    app.import("old.xml", &book(OLD, "OTH", "Oldcaller", "20230101", false));
    app.state
        .set_source_edition(OLD, Ruleset::Any, &NullSink)
        .expect("set both");
    assert_eq!(stored(&app)["old test homebrew"], "both");
    let app = app.restart();
    let src = app.source(OLD);
    assert_eq!(
        (src["edition"].clone(), src["editionSetByUser"].clone()),
        (json!("any"), json!(true))
    );
    assert!(offers_class(&app, Ruleset::Dnd2014, "Oldcaller"));
    assert!(offers_class(&app, Ruleset::Dnd2024, "Oldcaller"));
}
