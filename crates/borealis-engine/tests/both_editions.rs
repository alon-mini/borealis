//! IM17: a book for Both editions (`any`) is offered to 2014 and 2024 characters alike and is not
//! "another edition" for either (R4); a 2014-only and a 2024-only book still stay out of the other
//! edition. A Both book's element is never superseded by a 2024 equivalent (it is not a 2014
//! element), so a 2024 character still gets it. Bundled core + SRD packs plus three small books.

use borealis_content::{ContentFile, ContentStoreBuilder, PackOrigin, Ruleset};
use borealis_engine::commands;
use borealis_engine::snapshot::{CharacterSnapshot, SlotSnapshot};
use borealis_engine::Engine;
use serde_json::json;
use std::path::Path;

const BOTH: &str = "ID_T_BOTH_CLASS";
const OLD: &str = "ID_T_OLD_CLASS";
const NEW: &str = "ID_T_NEW_CLASS";
const BOTH_FEAT: &str = "ID_T_BOTH_FEAT";
const NEW_FEAT: &str = "ID_T_NEW_FEAT";

fn class(id: &str, name: &str, book: &str, ruleset: &str) -> serde_json::Value {
    json!({"id": id, "name": name, "type": "Class", "source": book, "ruleset": ruleset,
        "setters": [{"name": "hd", "value": "d8"}]})
}

fn engine() -> Engine {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let file: ContentFile = serde_json::from_value(json!({
    "format": "borealis-content/1",
    "elements": [
        class(BOTH, "Both Walker", "Both Book", "any"),
        class(OLD, "Old Walker", "Old Book", "dnd2014"),
        class(NEW, "New Walker", "New Book", "dnd2024"),
        {"id": BOTH_FEAT, "name": "Walker's Gift", "type": "Feat", "source": "Both Book",
         "ruleset": "any", "supports": ["T Gift"]},
        {"id": NEW_FEAT, "name": "Walker's Gift", "type": "Feat", "source": "New Book",
         "ruleset": "dnd2024", "supports": ["T Gift"],
         "maps_to": {"dnd2014": BOTH_FEAT, "kind": "equivalent"}}
    ]}))
    .expect("synthetic content");
    let store = ContentStoreBuilder::new()
        .add_pack_dir(&root.join("core"))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.1")))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.2.1")))
        .expect("bundled packs")
        .add_file("books.json", PackOrigin::Custom, file)
        .build();
    Engine::new(&store)
}

fn class_slot(snap: &CharacterSnapshot) -> &SlotSnapshot {
    snap.slots
        .iter()
        .find(|s| s.ty == "Class" && s.chosen.is_none())
        .expect("class slot")
}

fn offers(snap: &CharacterSnapshot, id: &str) -> bool {
    class_slot(snap).options.iter().any(|o| o.id == id)
}

#[test]
fn a_both_editions_class_is_offered_to_2014_and_2024_characters() {
    let e = engine();
    let old = e.derive(&commands::new_character(&e, Ruleset::Dnd2014));
    assert!(offers(&old, BOTH) && offers(&old, OLD) && !offers(&old, NEW));
    let new = e.derive(&commands::new_character(&e, Ruleset::Dnd2024));
    assert!(offers(&new, BOTH) && offers(&new, NEW) && !offers(&new, OLD));
}

/// Not "another edition" for either: offered without a foreign-edition badge in both.
#[test]
fn a_both_editions_class_is_not_another_edition_for_either() {
    let e = engine();
    for ruleset in [Ruleset::Dnd2014, Ruleset::Dnd2024] {
        let snap = e.derive(&commands::new_character(&e, ruleset));
        let both = class_slot(&snap)
            .options
            .iter()
            .find(|o| o.id == BOTH)
            .expect("offered");
        assert_eq!(both.edition, None, "{ruleset:?}");
    }
}

/// A 2024 element that maps to a Both element does not supersede it: the Both element is not a
/// 2014 element.
#[test]
fn a_both_editions_element_is_never_superseded() {
    let e = engine();
    let both = e.universe(Ruleset::Dnd2024).get(BOTH_FEAT).expect("loaded");
    assert!(
        !both.superseded,
        "a Both element is not replaced by a 2024 equivalent"
    );
    // a bundled `any` element (a core language) is still replaced by its 2024 version
    let elvish = e
        .universe(Ruleset::Dnd2024)
        .get("ID_LANGUAGE_ELVISH")
        .expect("core language");
    assert!(elvish.superseded);
}
