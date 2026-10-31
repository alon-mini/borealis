//! IM11: supports tags that content appends onto a 2014 element the 2024 universe supersedes
//! (`maps_to` kind `equivalent`) also apply to its native 2024 equivalent.
//!
//! A homebrew class spell list is often built from appends onto 2014 PHB spell ids. In a 2024
//! universe those spells are superseded (never offered for new picks), so without this the
//! list's select would offer nothing. Only the tags the appends added count (the store records
//! them per element); the 2014 element's own supports are already modelled natively by its 2024
//! version. The superseded element keeps its tags, so a stored pick of it still replays. Nothing
//! changes in a 2014 universe, and stored character data is untouched (R4).
//!
//! IM16: the superseded elements' own tags that no native element of the type carries are also
//! recorded on the native element (`UElem::replaced_supports`, with the replaced ids in
//! `UElem::replaced_ids`), as a second tag set its supports matching falls back on, so a 2014
//! select naming a tag only the 2014 versions carry (`Starting` languages) offers the 2024
//! version. A tag native elements carry (a class list such as `Warlock`, a spell level, a school)
//! is left out: the 2024 content answers it itself, and carrying the 2014 one across would widen
//! native 2024 lists to their 2014 contents (second review H1). Nothing else reads the set.

use crate::ids;
use crate::universe::UElem;
use borealis_content::{ContentStore, MapKind, Ruleset};
use std::collections::{HashMap, HashSet};

/// Add to each native 2024 element the supports that appends put on the superseded elements it
/// is `equivalent` to (same type), plus the names of the `ID_` support tags among them.
pub(crate) fn share(
    elems: &mut [UElem],
    store: &ContentStore,
    ruleset: Ruleset,
    support_names: &HashMap<&str, &str>,
) {
    if ruleset != Ruleset::Dnd2024 {
        return;
    }
    let pos: HashMap<&str, usize> = elems
        .iter()
        .enumerate()
        .map(|(i, u)| (u.el.id.as_str(), i))
        .collect();
    let native = native_tags(elems, ruleset);
    let additions: Vec<(usize, Vec<String>, Replaced)> = elems
        .iter()
        .enumerate()
        .filter(|(_, u)| u.el.ruleset == Some(ruleset))
        .filter_map(|(i, u)| {
            let tags = appended_onto_superseded(u, elems, &pos, store, support_names);
            let replaced = superseded_tags(u, elems, &pos, &native);
            (!tags.is_empty() || !replaced.ids.is_empty()).then_some((i, tags, replaced))
        })
        .collect();
    for (i, tags, replaced) in additions {
        elems[i].supports.extend(tags);
        elems[i].replaced_supports = replaced.tags;
        elems[i].replaced_ids = replaced.ids;
    }
}

/// IM16: what a native element stands in for: the replaced elements' ids and their tags that no
/// native element of the type carries.
#[derive(Default)]
struct Replaced {
    ids: Vec<String>,
    tags: Vec<String>,
}

/// Per type, every tag an element offered natively in this universe carries (its own edition or
/// edition-neutral, not superseded).
fn native_tags(elems: &[UElem], ruleset: Ruleset) -> HashMap<&str, HashSet<&str>> {
    let mut out: HashMap<&str, HashSet<&str>> = HashMap::new();
    for u in elems
        .iter()
        .filter(|u| !u.superseded && u.el.ruleset.is_none_or(|r| r.compatible_with(ruleset)))
    {
        out.entry(u.el.ty.as_str())
            .or_default()
            .extend(u.supports.iter().map(String::as_str));
    }
    out
}

/// The superseded counterparts of native `u` (`maps_to` kind `equivalent`, same type).
fn superseded_counterparts<'a>(
    u: &'a UElem,
    elems: &'a [UElem],
    pos: &'a HashMap<&str, usize>,
) -> impl Iterator<Item = &'a UElem> + 'a {
    u.el.maps_to
        .as_ref()
        .filter(|m| m.kind == Some(MapKind::Equivalent))
        .into_iter()
        .flat_map(|m| [&m.dnd2014, &m.dnd2024])
        .flatten()
        .filter(move |t| **t != u.el.id)
        .filter_map(move |t| pos.get(t.as_str()).map(|&j| &elems[j]))
        .filter(move |c| c.superseded && c.el.ty == u.el.ty)
}

/// IM16: the superseded counterparts of native `u` (empty when it replaces none): their ids, and
/// their tags that no native element of the type carries.
fn superseded_tags(
    u: &UElem,
    elems: &[UElem],
    pos: &HashMap<&str, usize>,
    native: &HashMap<&str, HashSet<&str>>,
) -> Replaced {
    let own = native.get(u.el.ty.as_str());
    let mut out = Replaced::default();
    for c in superseded_counterparts(u, elems, pos) {
        out.ids.push(c.el.id.clone());
        for t in &c.supports {
            let carried = own.is_some_and(|n| n.contains(t.as_str()));
            if !carried && !out.tags.contains(t) {
                out.tags.push(t.clone());
            }
        }
    }
    out
}

/// The appended tags of the superseded counterparts of native `u` that `u` lacks.
fn appended_onto_superseded(
    u: &UElem,
    elems: &[UElem],
    pos: &HashMap<&str, usize>,
    store: &ContentStore,
    support_names: &HashMap<&str, &str>,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for target in superseded_counterparts(u, elems, pos) {
        let Some(stored) = store.get(&target.el.id) else {
            continue;
        };
        for tag in &stored.appended_supports {
            let name = tag
                .starts_with(ids::SUPPORT_PREFIX)
                .then(|| support_names.get(tag.as_str()))
                .flatten()
                .map(|n| (*n).to_string());
            for t in std::iter::once(tag.clone()).chain(name) {
                if !u.supports.contains(&t) && !out.contains(&t) {
                    out.push(t);
                }
            }
        }
    }
    out
}
