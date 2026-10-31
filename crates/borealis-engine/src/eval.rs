//! Evaluators for the expression languages of the content format over engine state:
//! requirements, supports and equipped conditions.

use crate::ids;
use crate::universe::{Cond, UElem};
use borealis_content::expr::{
    BoolExpr, Dynamic, EquippedExpr, EquippedTest, RequirementLeaf, RequirementsExpr, SupportsExpr,
    SupportsLeaf, TestValue,
};
use std::cell::Cell;
use std::collections::{HashMap, HashSet};

/// Evaluate a boolean tree with a leaf predicate.
pub fn eval_bool<L>(expr: &BoolExpr<L>, leaf: &dyn Fn(&L) -> bool) -> bool {
    match expr {
        BoolExpr::Leaf(l) => leaf(l),
        BoolExpr::Not(e) => !eval_bool(e, leaf),
        BoolExpr::And(items) => items.iter().all(|e| eval_bool(e, leaf)),
        BoolExpr::Or(items) => items.iter().any(|e| eval_bool(e, leaf)),
    }
}

/// Counts of live element ids (multiset), minus an optional exclusion (owner environment).
#[derive(Debug, Default, Clone)]
pub struct IdCounts(pub HashMap<String, usize>);

impl IdCounts {
    /// Increment.
    pub fn add(&mut self, id: &str) {
        // a known id is counted without allocating its key again (graph builds add every node)
        if let Some(c) = self.0.get_mut(id) {
            *c += 1;
        } else {
            self.0.insert(id.to_string(), 1);
        }
    }

    /// Decrement.
    pub fn remove(&mut self, id: &str) {
        if let Some(c) = self.0.get_mut(id) {
            *c = c.saturating_sub(1);
            if *c == 0 {
                self.0.remove(id);
            }
        }
    }

    /// Count of an id.
    #[must_use]
    pub fn count(&self, id: &str) -> usize {
        self.0.get(id).copied().unwrap_or(0)
    }
}

/// Everything a requirement expression can look at.
#[derive(Debug, Clone, Copy)]
pub struct ReqEnv<'a> {
    /// Live element ids.
    pub ids: &'a IdCounts,
    /// Ids to subtract (the owner environment of a grant rule).
    pub exclude: Option<&'a IdCounts>,
    /// Final ability scores (STR..CHA).
    pub abilities: [i32; 6],
    /// Total character level.
    pub total_level: i32,
    /// Levels per class (lower-cased class name).
    pub class_levels: &'a HashMap<String, i32>,
    /// Statistic group sums (for `[some:stat:N]` keys).
    pub stats: &'a HashMap<String, i32>,
    /// Level of the class that owns the select rule being filtered.
    pub rule_class_level: Option<i32>,
    /// Set when a test fell back to a statistic group lookup.
    pub stat_used: Option<&'a Cell<bool>>,
    /// Lower-cased element types of the live character (for `[type:spell]`); `None` = none.
    pub types: Option<&'a IdCounts>,
    /// Element names of the live character as [`feature_name_key`] (for `[feature:<name>]`);
    /// `None` = none.
    pub names: Option<&'a IdCounts>,
    /// Some live element has a spellcasting block (`[feature:spellcasting]`).
    pub spell_blocks: bool,
}

/// Requirement key of the by-name feature term (`[feature:<name>]`).
const FEATURE_KEY: &str = "feature";
/// Requirement key of the strict spell-slot term (`[spellcasting:N]`).
const SPELLCASTING_KEY: &str = "spellcasting";

/// The key of an element name in [`ReqEnv::names`]: lower-cased, with every `:`-separated
/// part trimmed (the requirement parser trims around the last `:` of `[feature:A: B]`).
#[must_use]
pub fn feature_name_key(name: &str) -> String {
    name.split(':')
        .map(str::trim)
        .collect::<Vec<_>>()
        .join(":")
        .to_lowercase()
}

/// Spell level of a slot statistic group: `<name>:spellcasting:slots:N` or
/// `spellcasting:slots:N` with `N` in 1..=9 (`engine.md` 10.5).
fn slot_group_level(group: &str) -> Option<i32> {
    let (head, n) = group.rsplit_once(':')?;
    let n: i32 = n.parse().ok().filter(|n| (1..=9).contains(n))?;
    (head == "spellcasting:slots" || head.ends_with(":spellcasting:slots")).then_some(n)
}

impl ReqEnv<'_> {
    /// True if an element with this id is present.
    #[must_use]
    pub fn has_id(&self, id: &str) -> bool {
        let n = self.ids.count(id);
        let ex = self.exclude.map_or(0, |e| e.count(id));
        n > ex
    }

    /// `[feature:<name>]` (Borealis extension; also the structured
    /// `data.prerequisite.requires_feature` check): some live element of the character is named
    /// `<name>` (case-insensitive, trimmed; any element type, as Aurora class and racial features
    /// are plain elements). `[feature:spellcasting]` also holds when any live element has a
    /// spellcasting block (lenient: a feat or species spellcasting block counts, and a class
    /// block counts before its first spell slot). Use `[spellcasting:1]` for the strict
    /// "Spellcasting or Pact Magic feature" rule. Like `[type:x]` it reads the live character,
    /// not the owner-excluded id set (`engine.md` 3.6).
    #[must_use]
    pub fn has_feature(&self, name: &str) -> bool {
        let name = name.trim();
        self.names
            .is_some_and(|n| n.count(&feature_name_key(name)) > 0)
            || (self.spell_blocks && name.eq_ignore_ascii_case("spellcasting"))
    }

    /// At least one class spell slot (Spellcasting or Pact Magic), the strict check behind
    /// `data.prerequisite.requires_feature: Spellcasting`.
    #[must_use]
    pub fn has_class_spell_slots(&self) -> bool {
        self.has_spell_slots(1)
    }

    /// `[spellcasting:N]` (Borealis extension, strict): the character has at least one spell
    /// slot of level `N` or higher from a class Spellcasting or Pact Magic feature, read from
    /// the slot statistic groups `<class>:spellcasting:slots:<level>` (pact slots included,
    /// `engine.md` 10.5) of the previous statistic pass, like other statistic terms. This is
    /// the 2024 "Spellcasting or Pact Magic feature" prerequisite: a feat or species
    /// spellcasting block grants no slots and does not count, nor does a 2014 half caster
    /// before its first slot. `N` below 1 means 1.
    fn has_spell_slots(&self, min_level: i64) -> bool {
        if let Some(c) = self.stat_used {
            c.set(true);
        }
        let min = i32::try_from(min_level.max(1)).unwrap_or(i32::MAX);
        self.stats
            .iter()
            .any(|(k, v)| *v > 0 && slot_group_level(k).is_some_and(|l| l >= min))
    }

    /// Text-valued terms: `[type:x]` (some live element has that type, case-insensitive) and
    /// `[feature:<name>]`; any other key with a text value never holds (`engine.md` 5.1).
    fn text_test(&self, key: &str, value: &str) -> bool {
        let key = key.trim();
        if key.eq_ignore_ascii_case(FEATURE_KEY) {
            return self.has_feature(value);
        }
        // `[feature:Name: Part]` splits at the last `:`; the name is everything after `feature:`.
        if let Some(head) = key
            .get(..FEATURE_KEY.len() + 1)
            .filter(|h| h.eq_ignore_ascii_case("feature:"))
        {
            return self.has_feature(&format!("{}:{value}", &key[head.len()..]));
        }
        key.eq_ignore_ascii_case("type")
            && self
                .types
                .is_some_and(|t| t.count(&value.trim().to_lowercase()) > 0)
    }

    fn test(&self, key: &str, value: &TestValue) -> bool {
        let value = match value {
            TestValue::Number(n) if key.trim().eq_ignore_ascii_case(FEATURE_KEY) => {
                return self.has_feature(&n.to_string());
            }
            TestValue::Number(n) => *n,
            TestValue::Text(t) => return self.text_test(key, t),
        };
        let key = key.trim().to_lowercase();
        if key == SPELLCASTING_KEY {
            return self.has_spell_slots(value);
        }
        let value = i32::try_from(value).unwrap_or(i32::MAX);
        if let Some(i) = ids::ability_index(&key) {
            return self.abilities[i] >= value;
        }
        match key.as_str() {
            "character" => self.total_level >= value,
            "level" => self.rule_class_level.unwrap_or(self.total_level) >= value,
            _ => {
                if let Some(l) = self.class_levels.get(&key) {
                    return *l >= value;
                }
                if let Some(c) = self.stat_used {
                    c.set(true);
                }
                self.stats.get(&key).is_some_and(|s| *s >= value)
            }
        }
    }
}

/// Evaluate a requirement condition. Unparsable text never holds.
#[must_use]
pub fn requirement_holds(cond: &Cond<RequirementsExpr>, env: &ReqEnv) -> bool {
    match cond {
        Cond::None => true,
        Cond::Invalid => false,
        Cond::Expr(e) => eval_bool(e.root(), &|leaf| match leaf {
            RequirementLeaf::Id(id) => env.has_id(id),
            RequirementLeaf::Test(t) => env.test(&t.key, &t.value),
        }),
    }
}

/// The ids a requirement condition names under an even number of `!` (holding one can help the
/// condition hold): an id named only negated can only break it.
#[must_use]
pub fn positive_requirement_ids(cond: &Cond<RequirementsExpr>) -> HashSet<&str> {
    fn walk<'a>(e: &'a BoolExpr<RequirementLeaf>, negated: bool, out: &mut HashSet<&'a str>) {
        match e {
            BoolExpr::Leaf(RequirementLeaf::Id(id)) if !negated => {
                out.insert(id.as_str());
            }
            BoolExpr::Leaf(_) => {}
            BoolExpr::Not(e) => walk(e, !negated, out),
            BoolExpr::And(items) | BoolExpr::Or(items) => {
                for e in items {
                    walk(e, negated, out);
                }
            }
        }
    }
    let mut out = HashSet::new();
    if let Cond::Expr(e) = cond {
        walk(e.root(), false, &mut out);
    }
    out
}

/// The element ids a requirement condition names (its id leaves, each once): the only ids
/// [`requirement_holds`] looks up.
#[must_use]
pub fn requirement_ids(cond: &Cond<RequirementsExpr>) -> HashSet<&str> {
    fn walk<'a>(e: &'a BoolExpr<RequirementLeaf>, out: &mut HashSet<&'a str>) {
        match e {
            BoolExpr::Leaf(RequirementLeaf::Id(id)) => {
                out.insert(id.as_str());
            }
            BoolExpr::Leaf(RequirementLeaf::Test(_)) => {}
            BoolExpr::Not(e) => walk(e, out),
            BoolExpr::And(items) | BoolExpr::Or(items) => {
                for e in items {
                    walk(e, out);
                }
            }
        }
    }
    let mut out = HashSet::new();
    if let Cond::Expr(e) = cond {
        walk(e.root(), &mut out);
    }
    out
}

/// Information about the element in a hand or armor slot for equipped conditions.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HeldItem {
    /// Lower-cased id.
    pub id: String,
    /// Lower-cased name.
    pub name: String,
    /// Lower-cased `armor` setter (`light`, `medium`, `heavy`, `shield`).
    pub armor_kind: String,
    /// Is a weapon.
    pub weapon: bool,
    /// Has versatile damage.
    pub versatile_damage: bool,
    /// Counts as a shield (armor group shield).
    pub shield: bool,
}

/// Equipment facts the equipped evaluator reads.
#[derive(Debug, Clone, Default)]
pub struct EquipState {
    /// Body armor.
    pub armor: Option<HeldItem>,
    /// Primary hand item.
    pub primary: Option<HeldItem>,
    /// Secondary hand item.
    pub secondary: Option<HeldItem>,
    /// The same item occupies both hands.
    pub both_hands: bool,
    /// Lower-cased ids of attuned items (and adorners).
    pub attuned: HashSet<String>,
    /// Lower-cased ids of equipped items (and adorners).
    pub equipped: HashSet<String>,
    /// A generic "counts as equipped armor" grant is present.
    pub counts_any: bool,
    /// Counts-as light / medium / heavy grants.
    pub counts_kind: [bool; 3],
}

impl EquipState {
    fn any_counts(&self) -> bool {
        self.counts_any || self.counts_kind.iter().any(|b| *b)
    }

    fn matches_item(item: &HeldItem, value: &str) -> bool {
        item.name == value || item.id == value
    }

    fn test(&self, t: &EquippedTest) -> bool {
        let v = t.value.as_str();
        match t.key.as_str() {
            "armor" => match v {
                "" | "any" => self.armor.is_some() || self.any_counts(),
                "none" => self.armor.is_none() && !self.any_counts(),
                "light" | "medium" | "heavy" => {
                    let idx = ["light", "medium", "heavy"].iter().position(|k| *k == v);
                    match &self.armor {
                        Some(a) => a.armor_kind == v,
                        None => idx.is_some_and(|i| self.counts_kind[i]),
                    }
                }
                other => self
                    .armor
                    .as_ref()
                    .is_some_and(|a| Self::matches_item(a, other)),
            },
            "shield" => {
                let shield = self.secondary.as_ref().filter(|s| s.shield);
                match v {
                    "" | "any" => shield.is_some(),
                    "none" => shield.is_none(),
                    other => shield.is_some_and(|s| Self::matches_item(s, other)),
                }
            }
            "main" | "primary" => match (&self.primary, v) {
                (p, "" | "any") => p.is_some(),
                (p, "none") => p.is_none(),
                (p, "weapon") => p.as_ref().is_some_and(|i| i.weapon),
                (p, "versatile") => {
                    p.as_ref().is_some_and(|i| i.versatile_damage) && self.both_hands
                }
                (p, other) => p.as_ref().is_some_and(|i| Self::matches_item(i, other)),
            },
            "offhand" | "secondary" => {
                let off = self.secondary.as_ref().filter(|s| !s.shield);
                match v {
                    "" | "any" => off.is_some(),
                    "none" => off.is_none(),
                    "weapon" => off.is_some_and(|i| i.weapon),
                    other => off.is_some_and(|i| Self::matches_item(i, other)),
                }
            }
            "attunement" | "attuned" => self.attuned.contains(v),
            "item" => self.equipped.contains(v),
            _ => false,
        }
    }
}

/// Evaluate an equipped condition.
#[must_use]
pub fn equipped_holds(cond: &Cond<EquippedExpr>, eq: &EquipState) -> bool {
    match cond {
        Cond::None => true,
        Cond::Invalid => false,
        Cond::Expr(e) => eval_bool(e.root(), &|t| eq.test(t)),
    }
}

/// Context for the dynamic `$(spellcasting:...)` tokens of a supports expression.
pub trait DynamicSupports {
    /// Does the element satisfy the dynamic token?
    fn matches(&self, dynamic: &Dynamic, element: &UElem) -> bool;
}

/// A [`DynamicSupports`] that matches nothing.
pub struct NoDynamics;

impl DynamicSupports for NoDynamics {
    fn matches(&self, _: &Dynamic, _: &UElem) -> bool {
        false
    }
}

/// Evaluate a supports expression against a candidate element. In ID-range mode (`ID_A|ID_B`)
/// an `ID_` term names an element; otherwise an `ID_` term matches an element of that id or a
/// support tag of that name, so one choice may mix single elements and categories
/// (`Artisan tools||ID_..._NAVIGATORS_TOOLS`).
///
/// IM16: a native 2024 element that replaces 2014 elements also matches when the expression
/// matches their tags ([`UElem::replaced_supports`]; the whole expression against those tags,
/// never a mix of the two sets).
#[must_use]
pub fn supports_match(
    expr: &SupportsExpr,
    element: &UElem,
    dynamics: &dyn DynamicSupports,
) -> bool {
    let range = expr.is_id_range_mode();
    let own = eval_bool(expr.root(), &|leaf| match leaf {
        SupportsLeaf::Tag(t) => {
            let is_id = t.starts_with("ID_");
            if range && is_id {
                element.el.id == *t
            } else {
                (is_id && element.el.id == *t) || element.supports.iter().any(|s| same_tag(s, t))
            }
        }
        SupportsLeaf::Dynamic(d) => dynamics.matches(d, element),
    });
    own || (!range
        && !element.replaced_supports.is_empty()
        && eval_bool(expr.root(), &|leaf| match leaf {
            SupportsLeaf::Tag(t) => element.replaced_supports.iter().any(|s| same_tag(s, t)),
            SupportsLeaf::Dynamic(d) => dynamics.matches(d, element),
        }))
}

/// Two support tags are the same, a typographic apostrophe (’) counting as a straight one (IM15:
/// homebrew writes `Spider's Cunning` in a select and `Spider’s Cunning` on its targets).
fn same_tag(a: &str, b: &str) -> bool {
    let fold = |c: char| if c == '’' { '\'' } else { c };
    a == b || (a.contains(['\'', '’']) && a.chars().map(fold).eq(b.chars().map(fold)))
}

/// Supports evaluation for a condition (absent = everything).
#[must_use]
pub fn supports_cond_match(
    cond: &Cond<SupportsExpr>,
    element: &UElem,
    dynamics: &dyn DynamicSupports,
) -> bool {
    match cond {
        Cond::None => true,
        Cond::Invalid => false,
        Cond::Expr(e) => supports_match(e, element, dynamics),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use borealis_content::Element;

    fn ids_of(list: &[&str]) -> IdCounts {
        let mut c = IdCounts::default();
        for i in list {
            c.add(i);
        }
        c
    }

    fn req(text: &str, env: &ReqEnv) -> bool {
        let c = match RequirementsExpr::parse(text).unwrap() {
            Some(e) => Cond::Expr(e),
            None => Cond::None,
        };
        requirement_holds(&c, env)
    }

    #[test]
    fn tv34_requirement_language() {
        let ids = ids_of(&["ID_AA", "ID_BB", "ID_WOTC_PHB_CLASS_FIGHTER"]);
        let mut cl = HashMap::new();
        cl.insert("wizard".to_string(), 3);
        let mut st = HashMap::new();
        st.insert("foo:bar".to_string(), 4);
        let env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [14, 12, 10, 10, 10, 10],
            total_level: 5,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: None,
            types: None,
            names: None,
            spell_blocks: false,
        };
        let t = |s: &str| req(s, &env);
        assert!(t("ID_AA&&ID_BB") && t("ID_AA&ID_BB") && t("ID_AA,ID_BB"));
        assert!(!t("ID_AA&&ID_CC"));
        assert!(t("ID_CC|ID_AA") && t("ID_CC||ID_AA"));
        assert!(t("!ID_CC") && t("!(ID_AA&&ID_CC)") && t("ID_AA,!ID_CC"));
        assert!(t("[str:13]") && t("[strength:14]") && !t("[str:15]"));
        assert!(t("([str:15]||[dex:12])") && !t("([dex:13],[wis:13])"));
        assert!(t("[level:5]") && !t("[level:6]") && t("[character:5]"));
        assert!(t("[wizard:3]") && !t("[wizard:4]"));
        assert!(t("[Wizard:3]"), "Keys fold case in both entry points");
        assert!(t("[foo:bar:4]") && !t("[foo:bar:5]") && !t("[nosuch:1]"));
        assert!(t(""));
    }

    #[test]
    fn type_terms_and_text_values() {
        let ids = ids_of(&["ID_AA"]);
        let types = ids_of(&["spell", "class"]);
        let cl = HashMap::new();
        let mut st = HashMap::new();
        st.insert("ranger:archetype".to_string(), 3);
        let mut env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [10; 6],
            total_level: 1,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: None,
            types: Some(&types),
            names: None,
            spell_blocks: false,
        };
        assert!(req("[type:spell]", &env) && req("[type:Spell]", &env));
        assert!(req("[TYPE:class]", &env) && !req("[type:feat]", &env));
        assert!(req("ID_AA,[type:spell]", &env) && req("![type:feat]", &env));
        assert!(
            !req("[ranger:archetype:swarmkeeper]", &env),
            "Text on a non-type key is false even when the group exists"
        );
        assert!(!req("[shield:any]", &env) && !req("[level:]", &env));
        assert!(req("![armor:none]", &env));
        env.types = None;
        assert!(!req("[type:spell]", &env));
    }

    #[test]
    fn feature_terms_match_live_names_anywhere_in_an_expression() {
        let ids = ids_of(&["ID_AA"]);
        let names = ids_of(&["fighting style", "eldritch invocations", "foo:bar", "2"]);
        let cl = HashMap::new();
        let st = HashMap::new();
        let mut env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [10; 6],
            total_level: 1,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: None,
            types: None,
            names: Some(&names),
            spell_blocks: false,
        };
        assert!(req("[feature:Fighting Style]", &env) && req("[FEATURE: fighting style ]", &env));
        assert!(!req("[feature:Pact Magic]", &env) && req("![feature:Pact Magic]", &env));
        assert!(req(
            "[feature:Pact Magic]||[feature:Eldritch Invocations]",
            &env
        ));
        assert!(req("ID_ZZ|([feature:Fighting Style],ID_AA)", &env));
        assert!(!req("ID_ZZ|([feature:Fighting Style],ID_BB)", &env));
        assert!(req("[feature:Foo: Bar]", &env), "names may contain a colon");
        assert!(req("[feature:2]", &env), "numeric-looking names are names");
        assert!(!req("[feature:spellcasting]", &env));
        env.spell_blocks = true;
        assert!(
            req("[feature:Spellcasting]", &env),
            "any spellcasting block (lenient)"
        );
        assert!(env.has_feature("fighting style") && !env.has_feature("style"));
        env.names = None;
        assert!(!req("[feature:Fighting Style]", &env));
    }

    #[test]
    fn spellcasting_term_needs_class_spell_slots() {
        let ids = IdCounts::default();
        let cl = HashMap::new();
        let mut st = HashMap::new();
        st.insert("wizard:spellcasting:dc".to_string(), 13);
        st.insert("paladin:spellcasting:slots:1".to_string(), 0);
        let used = Cell::new(false);
        let mut env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [10; 6],
            total_level: 1,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: Some(&used),
            types: None,
            names: None,
            spell_blocks: true,
        };
        assert!(
            !req("[spellcasting:1]", &env),
            "a spellcasting block without slots"
        );
        assert!(
            used.get(),
            "reads statistics, so the derive loop converges on it"
        );
        let mut pact = st.clone();
        pact.insert("warlock:spellcasting:slots:3".to_string(), 2);
        env.stats = &pact;
        assert!(req("[spellcasting:1]", &env) && req("[Spellcasting:3]", &env));
        assert!(!req("[spellcasting:4]", &env) && req("[spellcasting:0]", &env));
        assert!(req("ID_ZZ||[spellcasting:1]", &env));
        let mut pool = st.clone();
        pool.insert("spellcasting:slots:9".to_string(), 1);
        pool.insert("spellcasting:slots:10".to_string(), 1);
        pool.insert("slots:5".to_string(), 1);
        env.stats = &pool;
        assert!(req("[spellcasting:9]", &env));
        assert_eq!(slot_group_level("spellcasting:slots:10"), None);
        assert_eq!(slot_group_level("myspellcasting:slots:2"), None);
        assert_eq!(slot_group_level("multiclass:spellcasting:slots:2"), Some(2));
    }

    #[test]
    fn rule_class_level_overrides_level_key() {
        let ids = IdCounts::default();
        let cl = HashMap::new();
        let st = HashMap::new();
        let mut env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [10; 6],
            total_level: 8,
            class_levels: &cl,
            stats: &st,
            rule_class_level: Some(3),
            stat_used: None,
            types: None,
            names: None,
            spell_blocks: false,
        };
        assert!(
            !req("[level:4]", &env),
            "Owning class level inside an option filter"
        );
        env.rule_class_level = None;
        assert!(req("[level:4]", &env), "Total level otherwise");
    }

    #[test]
    fn id_prefixes_do_not_collide() {
        let ids = ids_of(&["ID_AB_CD"]);
        let cl = HashMap::new();
        let st = HashMap::new();
        let env = ReqEnv {
            ids: &ids,
            exclude: None,
            abilities: [10; 6],
            total_level: 1,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: None,
            types: None,
            names: None,
            spell_blocks: false,
        };
        assert!(req("ID_AB_CD", &env));
        assert!(!req("ID_AB_C", &env), "Token exact matching");
        assert!(!req("ID_AB_CDE", &env));
    }

    #[test]
    fn exclusion_hides_owner_children() {
        let ids = ids_of(&["ID_AA", "ID_AA"]);
        let ex = ids_of(&["ID_AA"]);
        let cl = HashMap::new();
        let st = HashMap::new();
        let mut env = ReqEnv {
            ids: &ids,
            exclude: Some(&ex),
            abilities: [10; 6],
            total_level: 1,
            class_levels: &cl,
            stats: &st,
            rule_class_level: None,
            stat_used: None,
            types: None,
            names: None,
            spell_blocks: false,
        };
        assert!(req("ID_AA", &env), "second copy still visible");
        env.exclude = None;
        assert!(req("ID_AA", &env));
        let ex2 = ids_of(&["ID_AA", "ID_AA"]);
        env.exclude = Some(&ex2);
        assert!(!req("ID_AA", &env));
    }

    fn held(id: &str, name: &str, kind: &str) -> HeldItem {
        HeldItem {
            id: id.into(),
            name: name.into(),
            armor_kind: kind.into(),
            ..HeldItem::default()
        }
    }

    fn eq_cond(s: &str, st: &EquipState) -> bool {
        equipped_holds(&Cond::Expr(EquippedExpr::parse(s).unwrap().unwrap()), st)
    }

    #[test]
    fn tv36_equipped_conditions() {
        let mut shield = held("id_shield", "shield", "shield");
        shield.shield = true;
        let none = EquipState::default();
        let scale = EquipState {
            armor: Some(held("scale", "scale mail", "medium")),
            ..EquipState::default()
        };
        let scale_shield = EquipState {
            secondary: Some(shield.clone()),
            ..scale.clone()
        };
        let shield_only = EquipState {
            secondary: Some(shield),
            ..EquipState::default()
        };
        let heavy_counts = EquipState {
            counts_kind: [false, false, true],
            ..EquipState::default()
        };
        let cols = [
            "[armor:none]",
            "[armor:any]",
            "[armor:medium]",
            "[shield:none]",
            "[armor:none],[shield:none]",
            "[armor:heavy]",
        ];
        let rows: [(&EquipState, [bool; 6]); 5] = [
            (&none, [true, false, false, true, true, false]),
            (&scale, [false, true, true, true, false, false]),
            (&scale_shield, [false, true, true, false, false, false]),
            (&shield_only, [true, false, false, false, false, false]),
            (&heavy_counts, [false, true, false, true, false, true]),
        ];
        for (state, expect) in rows {
            for (c, e) in cols.iter().zip(expect) {
                assert_eq!(eq_cond(c, state), e, "{c}");
            }
        }
        assert!(eq_cond("[armor:scale mail]", &scale));
        assert!(!eq_cond("[bogus:1]", &scale));
        let mut weapon = held("id_dagger", "dagger", "");
        weapon.weapon = true;
        let st = EquipState {
            secondary: Some(weapon),
            ..EquipState::default()
        };
        assert!(
            eq_cond("[offhand:weapon]", &st)
                && eq_cond("[offhand:any]", &st)
                && !eq_cond("[shield:any]", &st)
        );
    }

    #[test]
    fn tv35_supports_language() {
        let mut e = Element::new("ID_X", "X", "Spell", "S");
        e.supports = vec![
            "Skill".into(),
            "Cleric".into(),
            "Wisdom".into(),
            "Ritual".into(),
            "0".into(),
        ];
        let mut u = crate::universe::Universe::new(
            &borealis_content::ContentStoreBuilder::new().build(),
            crate::profile::default_ruleset(),
        );
        let _ = &mut u;
        let ue = crate::universe::UElem {
            supports: e.supports.clone(),
            el: e,
            rules: vec![],
            req: Cond::None,
            copied_rules: 0,
            derived: false,
            edition: crate::universe::EditionStatus::Native,
            allow_duplicate: false,
            list_effects: Default::default(),
            prereq: Default::default(),
            repeatable: false,
            superseded: false,
            replaced_supports: Vec::new(),
            toggle_effects: Vec::new(),
            legacy_accepted: false,
            both_editions: false,
            user_edition_book: None,
        };
        let m =
            |s: &str| supports_match(&SupportsExpr::parse(s).unwrap().unwrap(), &ue, &NoDynamics);
        assert!(m("Skill,Cleric") && !m("Skill,Rogue") && m("Skill||Rogue"));
        assert!(!m("!Ritual") && m("Skill,!Rogue") && m("(Cleric||Wizard),0"));
        assert!(m("ID_X|ID_Y|ID_Z") && !m("ID_Y|ID_Z"), "id range mode");
        // a choice mixing single elements and a category (Guild Merchant: any artisan's tool
        // or navigator's tools): an `ID_` term names the element, a plain term is a tag
        assert!(
            m("Rogue||ID_X") && m("ID_X||Rogue") && m("ID_Y|Cleric"),
            "id and tag mixed"
        );
        assert!(
            !m("Rogue||ID_Y") && !m("ID_X,Rogue"),
            "the other terms still decide"
        );
    }
}
