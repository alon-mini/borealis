//! IM16 (GitHub #11 follow-up, B-79e): when a 2024 character's select is matched, a 2024 element
//! that replaces a 2014 element (`maps_to` kind `equivalent`) also matches the replaced element's
//! own tags, as IM11 already does for appended tags. Aurora-Lights' SRD Half-Elf names `Starting`,
//! which only the 2014 languages carry; in a 2024 character those are replaced by 2024 languages
//! without the tag, so the required choice offered nothing. Only supports matching changes: the
//! 2014 element is never offered to a 2024 character (R4), a 2014 character matches as before, and
//! a tag no element carries still offers nothing. Bundled core + SRD 5.2.1 plus a miniature.

use borealis_content::{ContentFile, ContentStoreBuilder, PackOrigin, Ruleset};
use borealis_engine::commands;
use borealis_engine::snapshot::{CharacterSnapshot, SlotSnapshot};
use borealis_engine::state::{CharacterState, Choice};
use borealis_engine::Engine;
use serde_json::json;
use std::path::Path;

const RACE: &str = "ID_T_HALF_FOLK";
const OLD: &str = "ID_T_OLD_TONGUE";
const NEW: &str = "ID_T_NEW_TONGUE";
const STARTING: &str = "Language (Half Folk)";
const MISSING: &str = "Lost Tongue";

fn engine() -> Engine {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let file: ContentFile = serde_json::from_value(json!({
        "format": "borealis-content/1",
        "elements": [
            {"id": RACE, "name": "Half Folk", "type": "Race", "source": "Test Book", "rules": [
                {"kind": "select", "type": "Language", "name": STARTING, "supports": "Starting", "level": 1},
                {"kind": "select", "type": "Language", "name": MISSING, "supports": "T PHB24 Lost", "level": 1}]},
            {"id": OLD, "name": "Old Tongue", "type": "Language", "source": "Test Book",
             "ruleset": "dnd2014", "supports": ["Standard", "Starting"]},
            {"id": NEW, "name": "Old Tongue", "type": "Language", "source": "Test Book 2024",
             "ruleset": "dnd2024", "supports": ["Standard"],
             "maps_to": {"dnd2014": OLD, "kind": "equivalent"}}
        ]}))
    .expect("synthetic content");
    let store = ContentStoreBuilder::new()
        .add_pack_dir(&root.join("core"))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.2.1")))
        .expect("bundled packs")
        .add_file("half.json", PackOrigin::Custom, file)
        .build();
    Engine::new(&store)
}

fn half_folk(e: &Engine, ruleset: Ruleset) -> CharacterState {
    let s = commands::new_character(e, ruleset);
    let key = commands::slot_key(&e.derive(&s), "ID_LEVEL_1", "Race", 1).expect("race slot");
    commands::select(e, &s, &key, Choice::Element(RACE.into()))
        .expect("race")
        .state
}

fn slot<'a>(snap: &'a CharacterSnapshot, name: &str) -> &'a SlotSnapshot {
    snap.slots
        .iter()
        .find(|x| x.name == name)
        .unwrap_or_else(|| panic!("no slot {name}"))
}

fn offers(snap: &CharacterSnapshot, name: &str, id: &str) -> bool {
    slot(snap, name).options.iter().any(|o| o.id == id)
}

#[test]
fn a_2024_replacement_matches_the_replaced_2014_elements_own_tags() {
    let e = engine();
    let snap = e.derive(&half_folk(&e, Ruleset::Dnd2024));
    assert!(
        offers(&snap, STARTING, NEW),
        "the 2024 tongue answers `Starting`"
    );
}

/// R4: the replaced 2014 element itself is never offered to a 2024 character, not even with the
/// other edition allowed, and cannot be picked.
#[test]
fn the_replaced_2014_element_is_never_offered_to_a_2024_character() {
    let e = engine();
    let mut s = half_folk(&e, Ruleset::Dnd2024);
    for cross in [false, true] {
        s.allow_cross_edition = Some(cross);
        assert!(
            !offers(&e.derive(&s), STARTING, OLD),
            "cross edition {cross}"
        );
    }
    let key = slot(&e.derive(&s), STARTING).key.clone();
    assert!(commands::select(&e, &s, &key, Choice::Element(OLD.into())).is_err());
}

/// A 2014 character matches as before: the 2014 tongue by its own tag, never the 2024 one.
#[test]
fn a_2014_characters_matching_is_unchanged() {
    let e = engine();
    let snap = e.derive(&half_folk(&e, Ruleset::Dnd2014));
    assert!(offers(&snap, STARTING, OLD));
    assert!(!offers(&snap, STARTING, NEW));
}

/// A tag neither element carries still offers nothing (the 2024 Wizard row of B-79e: content that
/// genuinely lacks the tag stays a content verdict).
#[test]
fn a_tag_no_element_carries_still_offers_nothing() {
    let e = engine();
    let snap = e.derive(&half_folk(&e, Ruleset::Dnd2024));
    assert!(slot(&snap, MISSING).options.is_empty());
}

/// Second review H1: the fallback only carries tags no native 2024 element of the type has. A
/// class spell-list tag such as `Warlock` is a native tag, so a native 2024 Warlock's list (and its
/// Mystic Arcanum) does not widen to the 2014 Warlock list through the 2014 counterparts of 2024
/// spells. Bundled core + SRD 5.1 + SRD 5.2.1, as every user has them.
fn bundled() -> Engine {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let store = ContentStoreBuilder::new()
        .add_pack_dir(&root.join("core"))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.1")))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.2.1")))
        .expect("bundled packs")
        .build();
    Engine::new(&store)
}

#[test]
fn a_native_2024_warlock_list_does_not_widen_to_the_2014_list() {
    let e = bundled();
    let s = commands::new_character(&e, Ruleset::Dnd2024);
    let key = commands::slot_key(&e.derive(&s), "ID_LEVEL_1", "Class", 1).expect("class slot");
    let mut s = commands::select(
        &e,
        &s,
        &key,
        Choice::Element("ID_2024_CLASS_WARLOCK".into()),
    )
    .expect("2024 warlock")
    .state;
    while s.level() < 11 {
        s = commands::level_up_main(&e, &s, None)
            .expect("level up")
            .state;
    }
    let snap = e.derive(&s);
    let warlock = snap.caster("Warlock").expect("warlock spellcasting");
    let listed: Vec<&str> = warlock.spells.iter().map(|x| x.id.as_str()).collect();
    assert!(
        !listed.contains(&"ID_2024_SPELL_SHATTER"),
        "Shatter is not on the 2024 Warlock list"
    );
    let arcanum: Vec<&str> = snap
        .slot(
            "ID_2024_CLASS_FEATURE_WARLOCK_MYSTIC_ARCANUM",
            "Mystic Arcanum (level 6)",
        )
        .expect("arcanum slot")
        .options
        .iter()
        .map(|o| o.id.as_str())
        .collect();
    for not_warlock in [
        "ID_2024_SPELL_CONJURE_FEY",
        "ID_2024_SPELL_FLESH_TO_STONE",
        "ID_2024_SPELL_MASS_SUGGESTION",
    ] {
        assert!(
            !arcanum.contains(&not_warlock),
            "{not_warlock} in {arcanum:?}"
        );
    }
    assert!(
        !arcanum.is_empty(),
        "the 2024 list's level 6 spells are offered"
    );
}

/// Second review H1: an `ID_` term of the expression names the replaced 2014 element in the
/// fallback too, so `!ID_<2014>` also excludes its 2024 replacement.
#[test]
fn an_id_exclusion_of_the_2014_element_excludes_its_2024_replacement() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../content");
    let file: ContentFile = serde_json::from_value(json!({
        "format": "borealis-content/1",
        "elements": [
            {"id": RACE, "name": "Half Folk", "type": "Race", "source": "Test Book", "rules": [
                {"kind": "select", "type": "Language", "name": STARTING, "supports": format!("Starting,!{OLD}"), "level": 1}]},
            {"id": OLD, "name": "Old Tongue", "type": "Language", "source": "Test Book",
             "ruleset": "dnd2014", "supports": ["Standard", "Starting"]},
            {"id": NEW, "name": "Old Tongue", "type": "Language", "source": "Test Book 2024",
             "ruleset": "dnd2024", "supports": ["Standard"],
             "maps_to": {"dnd2014": OLD, "kind": "equivalent"}},
            {"id": "ID_T_OTHER_14", "name": "Other Tongue", "type": "Language", "source": "Test Book",
             "ruleset": "dnd2014", "supports": ["Standard", "Starting"]},
            {"id": "ID_T_OTHER_24", "name": "Other Tongue", "type": "Language", "source": "Test Book 2024",
             "ruleset": "dnd2024", "supports": ["Standard"],
             "maps_to": {"dnd2014": "ID_T_OTHER_14", "kind": "equivalent"}}
        ]}))
    .expect("synthetic content");
    let store = ContentStoreBuilder::new()
        .add_pack_dir(&root.join("core"))
        .and_then(|b| b.add_pack_dir(&root.join("srd-5.2.1")))
        .expect("bundled packs")
        .add_file("half.json", PackOrigin::Custom, file)
        .build();
    let e = Engine::new(&store);
    let snap = e.derive(&half_folk(&e, Ruleset::Dnd2024));
    assert!(
        offers(&snap, STARTING, "ID_T_OTHER_24"),
        "the other tongue answers Starting"
    );
    assert!(
        !offers(&snap, STARTING, NEW),
        "`!{OLD}` excludes its 2024 replacement"
    );
}
