use super::{apply_append, load_order, ContentStore, LoadedIndex, StoredElement};
use crate::element::Append;
use crate::error::ContentError;
use crate::file::{ContentFile, IndexFile, PackFileKind, PackManifest, PackOrigin};
use crate::issue::{Issue, IssueCode};
use crate::ruleset::Ruleset;
use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

/// Summary of a loaded pack manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackInfo {
    /// Pack id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Pack version.
    pub version: String,
    /// Core or custom.
    pub origin: PackOrigin,
    /// Rulesets targeted.
    pub rulesets: Vec<Ruleset>,
}

#[derive(Debug, Clone)]
struct PendingFile {
    name: String,
    origin: PackOrigin,
    file: ContentFile,
}

/// Collects files and packs, then applies the load semantics in [`build`](Self::build).
///
/// Methods consume and return the builder so a store is assembled as one expression.
#[derive(Debug, Clone, Default)]
pub struct ContentStoreBuilder {
    files: Vec<PendingFile>,
    packs: Vec<PackInfo>,
    indexes: Vec<LoadedIndex>,
    diagnostics: Vec<Issue>,
    /// IM14: the user's edition per imported book, by [`super::source_key`].
    source_editions: BTreeMap<String, Ruleset>,
}

fn read_text(path: &Path) -> Result<String, ContentError> {
    std::fs::read_to_string(path).map_err(|e| ContentError::io(path, e))
}

fn safe_join(base: &Path, relative: &str) -> Result<PathBuf, ContentError> {
    let rel = Path::new(relative);
    let ok = rel
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    if relative.is_empty() || !ok {
        return Err(ContentError::UnsafePath(relative.to_string()));
    }
    Ok(base.join(rel))
}

impl ContentStoreBuilder {
    /// An empty builder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add an in-memory file. Files are applied in the order they are added.
    #[must_use]
    pub fn add_file(
        mut self,
        name: impl Into<String>,
        origin: PackOrigin,
        file: ContentFile,
    ) -> Self {
        self.files.push(PendingFile {
            name: name.into(),
            origin,
            file,
        });
        self
    }

    /// Add an index file (metadata only).
    #[must_use]
    pub fn add_index(mut self, name: impl Into<String>, index: IndexFile) -> Self {
        self.indexes.push(LoadedIndex {
            file: name.into(),
            index,
        });
        self
    }

    /// Load one content JSON file.
    ///
    /// # Errors
    /// I/O and JSON errors, tagged with the path.
    pub fn add_json_file(self, path: &Path, origin: PackOrigin) -> Result<Self, ContentError> {
        let text = read_text(path)?;
        let file = ContentFile::from_json_str(&text).map_err(|e| e.in_file(path))?;
        Ok(self.add_file(path.display().to_string(), origin, file))
    }

    /// Load a pack directory: `pack.json` plus the files it lists, in manifest order.
    ///
    /// # Errors
    /// I/O and JSON errors, and [`ContentError::UnsafePath`] for manifest entries that
    /// escape the directory.
    pub fn add_pack_dir(mut self, dir: &Path) -> Result<Self, ContentError> {
        let manifest_path = dir.join("pack.json");
        let manifest = PackManifest::from_json_str(&read_text(&manifest_path)?)
            .map_err(|e| e.in_file(&manifest_path))?;
        self.packs.push(PackInfo {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            origin: manifest.origin,
            rulesets: manifest.rulesets.clone(),
        });
        for entry in &manifest.files {
            let path = safe_join(dir, &entry.path)?;
            let text = read_text(&path)?;
            match entry.kind {
                PackFileKind::Content => {
                    let mut file =
                        ContentFile::from_json_str(&text).map_err(|e| e.in_file(&path))?;
                    if file.ruleset.is_none() && manifest.rulesets.len() == 1 {
                        file.ruleset = manifest.rulesets.first().copied();
                    }
                    self = self.add_file(
                        format!("{}/{}", manifest.id, entry.path),
                        manifest.origin,
                        file,
                    );
                }
                PackFileKind::Index => {
                    let index = IndexFile::from_json_str(&text).map_err(|e| e.in_file(&path))?;
                    self = self.add_index(format!("{}/{}", manifest.id, entry.path), index);
                }
            }
        }
        Ok(self)
    }

    /// Load every content `*.json` below `dir` (skipping `pack.json` and `*.index.json`),
    /// ordered by the custom folder load order.
    ///
    /// # Errors
    /// I/O and JSON errors, tagged with the path.
    pub fn add_dir(mut self, dir: &Path, origin: PackOrigin) -> Result<Self, ContentError> {
        let mut relative = Vec::new();
        collect_json(dir, dir, &mut relative)?;
        for rel in load_order::sorted(&relative) {
            if load_order::is_ignored_path(&rel) {
                continue;
            }
            let path = dir.join(&rel);
            let text = read_text(&path)?;
            let file = ContentFile::from_json_str(&text).map_err(|e| e.in_file(&path))?;
            self = self.add_file(rel, origin, file);
        }
        Ok(self)
    }

    /// IM14 (GitHub #11): the user's edition per imported book, keyed by
    /// [`super::source_key`] of the book's name. [`build`](Self::build) re-tags the book's
    /// elements in custom (imported) files: its `Source` element, elements naming it (or one of
    /// its `alternative` names) as their source, and `Internal`/`Core` helpers in a file whose
    /// other elements all belong to such books. Edition-neutral (`any`) elements and bundled
    /// files are never re-tagged. The files on disk are not changed.
    #[must_use]
    pub fn with_source_editions(mut self, editions: BTreeMap<String, Ruleset>) -> Self {
        self.source_editions = editions;
        self
    }

    /// Apply the load pipeline: ordered files, duplicate/override rules, then appends.
    ///
    /// * `ignore: true` files are skipped.
    /// * Core files: a duplicate id keeps the first definition (error diagnostic).
    /// * Custom files: a duplicate id replaces the earlier element, which moves to the end.
    /// * `<append>` records are applied last, in file order.
    #[must_use]
    pub fn build(self) -> ContentStore {
        let Self {
            mut files,
            packs,
            indexes,
            mut diagnostics,
            source_editions,
        } = self;
        let retagged = apply_source_editions(&mut files, &source_editions);
        let mut slots: Vec<Option<StoredElement>> = Vec::new();
        let mut position: HashMap<String, usize> = HashMap::new();
        let mut appends: Vec<(Arc<str>, Append)> = Vec::new();
        let mut loaded_files = Vec::new();

        for (file_index, pending) in files.into_iter().enumerate() {
            let name: Arc<str> = Arc::from(pending.name.as_str());
            if pending.file.is_ignored() {
                diagnostics.push(
                    Issue::info(
                        IssueCode::FileSkipped,
                        "file has ignore=true and was skipped",
                    )
                    .in_file(pending.name),
                );
                continue;
            }
            loaded_files.push(pending.name.clone());
            let file_ruleset = pending.file.ruleset;
            for (element_index, mut element) in pending.file.elements.into_iter().enumerate() {
                let user_edition_book = retagged.get(&(file_index, element_index)).cloned();
                if element.ruleset.is_none() {
                    element.ruleset = file_ruleset;
                }
                if let Some(&old) = position.get(&element.id) {
                    match pending.origin {
                        PackOrigin::Core => {
                            diagnostics.push(
                                Issue::error(
                                    IssueCode::DuplicateId,
                                    "duplicate element id in core content; first definition kept",
                                )
                                .in_file(name.to_string())
                                .at_element(element.id.clone()),
                            );
                            continue;
                        }
                        PackOrigin::Custom => {
                            let previous = slots[old].take();
                            let note = previous.as_ref().map_or_else(String::new, |p| {
                                if p.element.ty == element.ty {
                                    format!("replaced the definition from {}", p.file)
                                } else {
                                    format!(
                                        "replaced the definition from {} (type changed from {} to {})",
                                        p.file, p.element.ty, element.ty
                                    )
                                }
                            });
                            diagnostics.push(
                                Issue::info(IssueCode::ElementReplaced, note)
                                    .in_file(name.to_string())
                                    .at_element(element.id.clone()),
                            );
                        }
                    }
                }
                position.insert(element.id.clone(), slots.len());
                slots.push(Some(StoredElement {
                    element,
                    file: Arc::clone(&name),
                    origin: pending.origin,
                    extended: false,
                    appended_supports: Vec::new(),
                    user_edition_book,
                }));
            }
            appends.extend(
                pending
                    .file
                    .appends
                    .into_iter()
                    .map(|a| (Arc::clone(&name), a)),
            );
        }

        for (file, append) in appends {
            let Some(&idx) = position.get(&append.id) else {
                diagnostics.push(
                    Issue::warning(
                        IssueCode::AppendTargetMissing,
                        "append targets an element that does not exist",
                    )
                    .in_file(file.to_string())
                    .at_element(append.id.clone()),
                );
                continue;
            };
            if let Some(stored) = slots[idx].as_ref() {
                let (merged, changed) = apply_append(&stored.element, &append);
                if changed {
                    let added = merged
                        .supports
                        .iter()
                        .filter(|t| !stored.element.supports.contains(t))
                        .cloned();
                    let appended_supports = stored
                        .appended_supports
                        .iter()
                        .cloned()
                        .chain(added)
                        .collect();
                    slots[idx] = Some(StoredElement {
                        element: merged,
                        extended: true,
                        appended_supports,
                        ..stored.clone()
                    });
                }
            }
        }

        let elements = super::alias::resolve_phb24_aliases(
            slots.into_iter().flatten().collect(),
            |s: &StoredElement| &s.element,
            |s, element| StoredElement { element, ..s },
        );
        ContentStore::assemble(elements, loaded_files, packs, indexes, diagnostics)
    }
}

/// IM14: re-tag the elements of books the user set an edition for (see
/// [`ContentStoreBuilder::with_source_editions`]). Returns the book key that applied to each
/// (file, element) position it changed.
fn apply_source_editions(
    files: &mut [PendingFile],
    editions: &BTreeMap<String, Ruleset>,
) -> HashMap<(usize, usize), String> {
    let mut changed = HashMap::new();
    if editions.is_empty() {
        return changed;
    }
    let custom = |p: &PendingFile| p.origin == PackOrigin::Custom;
    // every name of a set book (its own and its `alternative` names) -> (edition, book key)
    let mut by_key: BTreeMap<String, (Ruleset, String)> = editions
        .iter()
        .map(|(k, r)| (k.clone(), (*r, k.clone())))
        .collect();
    // IM17: books the importer tagged for Both editions (their `Source` element is `any`): their
    // `any` tags came from the guess, so a set edition re-tags them too
    let mut guessed_both: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for p in files.iter().filter(|p| custom(p)) {
        for el in p.file.elements.iter().filter(|e| e.ty == "Source") {
            if el.ruleset.or(p.file.ruleset) == Some(Ruleset::Any) {
                guessed_both.insert(super::source_key(&el.name));
            }
        }
    }
    for el in files
        .iter()
        .filter(|p| custom(p))
        .flat_map(|p| &p.file.elements)
    {
        if el.ty != "Source" {
            continue;
        }
        let key = super::source_key(&el.name);
        if let Some(&r) = editions.get(&key) {
            for alt in el.setters.iter().filter(|s| s.name == "alternative") {
                by_key
                    .entry(super::source_key(&alt.value))
                    .or_insert_with(|| (r, key.clone()));
            }
        }
    }
    let book_of = |el: &crate::Element| {
        let name = if el.ty == "Source" {
            &el.name
        } else {
            &el.source
        };
        by_key.get(&super::source_key(name)).cloned()
    };
    for (fi, pending) in files.iter_mut().enumerate().filter(|(_, p)| custom(p)) {
        let file_ruleset = pending.file.ruleset;
        let books: Vec<Option<(Ruleset, String)>> = pending
            .file
            .elements
            .iter()
            .filter(|e| e.ty == "Source" || !super::is_unrestrictable_source(&e.source))
            .map(book_of)
            .collect();
        // helpers follow their file when every other element is of one set book
        let follow = books
            .first()
            .cloned()
            .flatten()
            .filter(|b| books.iter().all(|x| x.as_ref() == Some(b)));
        for (ei, el) in pending.file.elements.iter_mut().enumerate() {
            let helper = el.ty != "Source" && super::is_unrestrictable_source(&el.source);
            let set = if helper { follow.clone() } else { book_of(el) };
            let neutral = el.ruleset.or(file_ruleset) == Some(Ruleset::Any);
            if neutral && !set.as_ref().is_some_and(|(_, b)| guessed_both.contains(b)) {
                continue;
            }
            if let Some((r, book)) = set {
                el.ruleset = Some(r);
                changed.insert((fi, ei), book);
            }
        }
    }
    changed
}

fn collect_json(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), ContentError> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| ContentError::io(dir, e))?
        .collect::<Result<_, _>>()
        .map_err(|e| ContentError::io(dir, e))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| ContentError::io(&path, e))?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect_json(root, &path, out)?;
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        if lower.ends_with(".json") && lower != "pack.json" && !lower.ends_with(".index.json") {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    Ok(())
}

impl ContentStoreBuilder {
    /// Append an existing diagnostic (for callers that load files themselves).
    #[must_use]
    pub fn with_diagnostic(mut self, issue: Issue) -> Self {
        self.diagnostics.push(issue);
        self
    }
}
