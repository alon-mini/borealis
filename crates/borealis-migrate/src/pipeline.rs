//! Input discovery, conversion of whole trees, validation and output layout.
//!
//! [`migrate_path`] is pure with respect to the output (it returns the files to write);
//! [`write_output`] performs the writes. Output is deterministic: inputs are processed in
//! the custom-folder load order, maps are ordered and no timestamps are recorded, so
//! re-running on the same input yields identical bytes.

use crate::convert::{convert_xml, Document};
use crate::error::MigrateError;
use crate::load_reject;
use crate::report::{FileReport, MigrationReport, Stats};
use borealis_content::schema::{validate_document, DocumentKind};
use borealis_content::store::load_order;
use borealis_content::{
    ContentStoreBuilder, Issue, IssueCode, PackFile, PackFileKind, PackFormat, PackManifest,
    PackOrigin, Ruleset, Severity,
};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};

/// Options for a migration run.
#[derive(Debug, Clone)]
pub struct MigrateOptions {
    /// Pack id; derived from the input name when absent.
    pub pack_id: Option<String>,
    /// Pack display name; defaults to the id.
    pub pack_name: Option<String>,
    /// Pack version string.
    pub pack_version: String,
    /// Core (first definition wins) or custom (last wins) load semantics.
    pub origin: PackOrigin,
    /// Ruleset stamped on every converted content file.
    pub ruleset: Ruleset,
    /// License identifier recorded in the manifest.
    pub license: Option<String>,
    /// Attribution text recorded in the manifest.
    pub attribution: Option<String>,
    /// Run the cross-reference validator and schema check on the output.
    pub validate: bool,
}

impl Default for MigrateOptions {
    fn default() -> Self {
        Self {
            pack_id: None,
            pack_name: None,
            pack_version: "1.0.0".into(),
            origin: PackOrigin::Custom,
            ruleset: Ruleset::Dnd2014,
            license: None,
            attribution: None,
            validate: true,
        }
    }
}

/// One file to write, relative to the output directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputFile {
    /// Relative path using `/`.
    pub path: String,
    /// File contents.
    pub contents: String,
}

/// The result of a run.
#[derive(Debug, Clone)]
pub struct MigrateOutput {
    /// Converted files plus `pack.json`, sorted by path.
    pub files: Vec<OutputFile>,
    /// The migration report.
    pub report: MigrationReport,
}

struct Input {
    rel: String,
    path: PathBuf,
}

fn is_index(rel: &str) -> bool {
    rel.to_lowercase().ends_with(".index")
}

fn is_xml(rel: &str) -> bool {
    rel.to_lowercase().ends_with(".xml")
}

fn output_name(rel: &str) -> String {
    let lower = rel.to_lowercase();
    if lower.ends_with(".xml") {
        format!("{}.json", &rel[..rel.len() - 4])
    } else {
        format!("{rel}.json")
    }
}

fn safe_relative(name: &str) -> bool {
    let p = Path::new(name);
    !name.is_empty()
        && p.components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

/// macOS metadata beside real files (`._name` resource forks, `__MACOSX` in unpacked zips).
fn is_os_metadata(name: &str) -> bool {
    name.starts_with("._") || name == "__MACOSX"
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<(), MigrateError> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .map_err(|e| MigrateError::io(dir, e))?
        .collect::<Result<_, _>>()
        .map_err(|e| MigrateError::io(dir, e))?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().map_err(|e| MigrateError::io(&path, e))?;
        if kind.is_symlink() || is_os_metadata(&entry.file_name().to_string_lossy()) {
            continue;
        }
        if kind.is_dir() {
            walk(root, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(root) {
            let rel = rel.to_string_lossy().replace('\\', "/");
            if is_xml(&rel) || is_index(&rel) {
                out.push(rel);
            }
        }
    }
    Ok(())
}

fn slug(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "migrated-pack".into()
    } else {
        trimmed.to_string()
    }
}

/// Where the content directory of an index lives, relative to the same root.
fn index_content_dir(index_rel: &str) -> String {
    let (dir, file) = index_rel
        .rsplit_once('/')
        .map_or(("", index_rel), |(d, f)| (d, f));
    let stem = borealis_content::IndexFile::content_dir_name(file);
    if dir.is_empty() {
        stem.to_string()
    } else {
        format!("{dir}/{stem}")
    }
}

struct Run<'a> {
    opts: &'a MigrateOptions,
    root: PathBuf,
    issues: Vec<Issue>,
    reports: Vec<FileReport>,
    outputs: Vec<OutputFile>,
    converted: Vec<(String, borealis_content::ContentFile)>,
    manifest_files: Vec<(String, PackFileKind, String)>,
    output_names: BTreeSet<String>,
    /// Source element types by id (later files override earlier ones, as the store does).
    types: BTreeMap<String, String>,
    /// Ids renamed by [`crate::idnorm`] (source id -> new id).
    renamed: BTreeMap<String, String>,
}

impl Run<'_> {
    fn skipped(&mut self, rel: &str, issue: Issue) {
        self.issues.push(issue.in_file(rel));
        self.reports.push(FileReport {
            input: rel.to_string(),
            output: None,
            kind: "skipped".into(),
            stats: Stats::default(),
        });
    }

    /// Convert one file. Returns the existing entries of an index so callers can follow them.
    fn process(&mut self, input: &Input) -> Vec<String> {
        let rel = &input.rel;
        if load_order::is_ignored_path(rel) {
            self.skipped(
                rel,
                Issue::info(IssueCode::FileSkipped, "path is under custom/ignore"),
            );
            return Vec::new();
        }
        let text = match std::fs::read(&input.path)
            .map_err(|e| e.to_string())
            .and_then(|b| String::from_utf8(b).map_err(|e| format!("not valid UTF-8: {e}")))
        {
            Ok(t) => t,
            Err(e) => {
                self.skipped(
                    rel,
                    Issue::error(IssueCode::XmlParse, format!("cannot read file: {e}")),
                );
                return Vec::new();
            }
        };
        let conv = convert_xml(&text, rel);
        self.issues.extend(conv.issues);
        self.types.extend(conv.element_types);
        let mut stats = conv.stats;
        let document = match conv.document {
            // Aurora skips an `ignore="true"` file before parsing its elements.
            Some(Document::Content(file))
                if self.opts.origin == PackOrigin::Custom && file.ignore != Some(true) =>
            {
                // The raw XML, as Aurora reads it (convert_xml parsed it already, so it parses).
                let culprits = crate::dom::parse_document(&text)
                    .map(|root| load_reject::culprits(&root))
                    .unwrap_or_default();
                if culprits.is_empty() {
                    Some(Document::Content(file))
                } else {
                    self.issues
                        .extend(load_reject::discard_issues(rel, &text, &file, &culprits));
                    stats = load_reject::discarded_stats(&stats, &file);
                    None
                }
            }
            other => other,
        };
        let out_name = output_name(rel);
        let mut followed = Vec::new();
        let (kind, written) = match document {
            None => ("skipped", None),
            Some(_) if !self.output_names.insert(out_name.clone()) => {
                self.issues.push(
                    Issue::error(
                        IssueCode::DuplicateId,
                        format!("output name {out_name} is already used"),
                    )
                    .in_file(rel.clone()),
                );
                ("skipped", None)
            }
            Some(Document::Content(mut file)) => {
                file.ruleset = Some(self.opts.ruleset);
                match file.to_json_pretty() {
                    Ok(contents) => {
                        self.outputs.push(OutputFile {
                            path: out_name.clone(),
                            contents,
                        });
                        self.manifest_files.push((
                            rel.clone(),
                            PackFileKind::Content,
                            out_name.clone(),
                        ));
                        self.converted.push((rel.clone(), file));
                        ("content", Some(out_name))
                    }
                    Err(e) => {
                        self.issues.push(
                            Issue::error(IssueCode::SchemaViolation, e.to_string())
                                .in_file(rel.clone()),
                        );
                        ("skipped", None)
                    }
                }
            }
            Some(Document::Index(index)) => {
                followed = self.index_entries(rel, &index);
                match index.to_json_pretty() {
                    Ok(contents) => {
                        self.outputs.push(OutputFile {
                            path: out_name.clone(),
                            contents,
                        });
                        self.manifest_files.push((
                            rel.clone(),
                            PackFileKind::Index,
                            out_name.clone(),
                        ));
                        ("index", Some(out_name))
                    }
                    Err(e) => {
                        self.issues.push(
                            Issue::error(IssueCode::SchemaViolation, e.to_string())
                                .in_file(rel.clone()),
                        );
                        ("skipped", None)
                    }
                }
            }
        };
        self.reports.push(FileReport {
            input: rel.clone(),
            output: written,
            kind: kind.into(),
            stats,
        });
        followed
    }

    /// Where a repository checkout keeps an index entry: the entry's URL relative to the index's
    /// own update URL, under the index's folder (`core.index` at `.../master/core.index` lists
    /// `.../master/core/items/a.xml`: `core/items/a.xml`). Aurora's download layout puts it in
    /// `core/a.xml` instead; a cloned or zipped GitHub repository keeps the URL layout.
    fn at_url_path(
        &self,
        index_rel: &str,
        index: &borealis_content::IndexFile,
        url: &str,
    ) -> Option<String> {
        let own = index.info.remote_url()?;
        let base = &own[..=own.rfind('/')?];
        let rest = url.strip_prefix(base)?;
        if !safe_relative(rest) {
            return None;
        }
        let rel = match index_rel.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/{rest}"),
            None => rest.to_string(),
        };
        self.root.join(&rel).is_file().then_some(rel)
    }

    /// Check an index's entries against the local tree; return the existing ones.
    fn index_entries(&mut self, rel: &str, index: &borealis_content::IndexFile) -> Vec<String> {
        let dir = index_content_dir(rel);
        let mut present = Vec::new();
        for entry in index.files.iter().filter(|e| !e.is_obsolete()) {
            if !safe_relative(&entry.name) {
                self.issues.push(
                    Issue::error(
                        IssueCode::IndexEntryMissing,
                        format!(
                            "index entry name {:?} escapes the content directory and is ignored",
                            entry.name
                        ),
                    )
                    .in_file(rel),
                );
                continue;
            }
            let entry_rel = format!("{dir}/{}", entry.name);
            if self.root.join(&entry_rel).is_file() {
                present.push(entry_rel);
            } else if let Some(at_url) = self.at_url_path(rel, index, &entry.url) {
                present.push(at_url);
            } else {
                self.issues.push(
                    Issue::info(
                        IssueCode::IndexEntryMissing,
                        format!(
                            "index entry {} is not present locally (remote copy: {})",
                            entry.name, entry.url
                        ),
                    )
                    .in_file(rel),
                );
            }
        }
        present
    }
}

fn discover(input: &Path) -> Result<(PathBuf, Vec<String>, bool, String), MigrateError> {
    let meta = std::fs::symlink_metadata(input).map_err(|e| MigrateError::io(input, e))?;
    if meta.is_dir() {
        let mut rels = Vec::new();
        walk(input, input, &mut rels)?;
        let name = input
            .file_name()
            .map_or_else(|| "pack".into(), |n| n.to_string_lossy().to_string());
        Ok((input.to_path_buf(), rels, false, name))
    } else if meta.is_file() {
        let parent = input.parent().map_or_else(PathBuf::new, Path::to_path_buf);
        let file = input
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let stem = borealis_content::IndexFile::content_dir_name(&file).to_string();
        Ok((
            parent,
            vec![file],
            is_index(input.to_string_lossy().as_ref()),
            stem,
        ))
    } else {
        Err(MigrateError::InvalidInput(input.to_path_buf()))
    }
}

/// Migrate a file, a `.index` (following the entries present beside it) or a directory.
///
/// # Errors
/// [`MigrateError`] when the input cannot be read at all or the output cannot be built.
/// Problems inside individual files are reported as issues instead.
pub fn migrate_path(input: &Path, opts: &MigrateOptions) -> Result<MigrateOutput, MigrateError> {
    let (root, rels, follow_index, name) = discover(input)?;
    let mut run = Run {
        opts,
        root: root.clone(),
        issues: Vec::new(),
        reports: Vec::new(),
        outputs: Vec::new(),
        converted: Vec::new(),
        manifest_files: Vec::new(),
        output_names: BTreeSet::new(),
        types: BTreeMap::new(),
        renamed: BTreeMap::new(),
    };

    if follow_index {
        let mut queue: VecDeque<String> = rels.into();
        let mut seen = BTreeSet::new();
        while let Some(rel) = queue.pop_front() {
            if !seen.insert(rel.clone()) {
                continue;
            }
            let followed = run.process(&Input {
                path: root.join(&rel),
                rel,
            });
            queue.extend(followed);
        }
    } else {
        for rel in load_order::sorted(&rels) {
            run.process(&Input {
                path: root.join(&rel),
                rel,
            });
        }
    }

    normalise_ids(&mut run)?;
    let tagged = crate::edition::tag_editions(&mut run.converted, opts.ruleset);
    reserialise(&mut run, tagged)?;
    if opts.validate {
        validate_output(&mut run)?;
    }

    let pack_id = opts.pack_id.clone().unwrap_or_else(|| slug(&name));
    let mut ordered = run.manifest_files.clone();
    let order = load_order::sorted(
        &ordered
            .iter()
            .map(|(rel, _, _)| rel.clone())
            .collect::<Vec<_>>(),
    );
    ordered.sort_by_key(|(rel, _, _)| order.iter().position(|r| r == rel));
    let manifest = PackManifest {
        format: PackFormat,
        id: pack_id.clone(),
        name: opts.pack_name.clone().unwrap_or_else(|| pack_id.clone()),
        version: opts.pack_version.clone(),
        origin: opts.origin,
        rulesets: pack_rulesets(opts.ruleset, &run.converted),
        license: opts.license.clone(),
        attribution: opts.attribution.clone(),
        description: Some("Migrated from Aurora XML by borealis-migrate".into()),
        files: ordered
            .iter()
            .map(|(_, kind, out)| PackFile {
                path: out.clone(),
                kind: *kind,
            })
            .collect(),
    };
    let mut files = run.outputs;
    files.push(OutputFile {
        path: "pack.json".into(),
        contents: manifest.to_json_pretty()?,
    });
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let report =
        MigrationReport::new(run.reports, run.issues).with_elements(run.types, run.renamed);
    Ok(MigrateOutput { files, report })
}

/// Rewrite ids that Borealis rejects (see [`crate::idnorm`]) and re-serialise the touched files.
fn normalise_ids(run: &mut Run<'_>) -> Result<(), MigrateError> {
    let (changed, issues, renamed) = crate::idnorm::normalise(&mut run.converted)?;
    run.issues.extend(issues);
    for (old, new) in &renamed {
        if let Some(ty) = run.types.get(old).cloned() {
            run.types.insert(new.clone(), ty);
        }
    }
    run.renamed = renamed;
    reserialise(run, changed)
}

/// Write the converted files at `changed` (indices into `run.converted`) to their outputs again.
fn reserialise(run: &mut Run<'_>, changed: Vec<usize>) -> Result<(), MigrateError> {
    for i in changed {
        let (rel, file) = &run.converted[i];
        let name = output_name(rel);
        let contents = file.to_json_pretty()?;
        if let Some(out) = run.outputs.iter_mut().find(|o| o.path == name) {
            out.contents = contents;
        }
    }
    Ok(())
}

/// The run's ruleset first, then any other ruleset its files or elements were tagged with.
fn pack_rulesets(run: Ruleset, files: &[(String, borealis_content::ContentFile)]) -> Vec<Ruleset> {
    let mut out = vec![run];
    let tags = files
        .iter()
        .flat_map(|(_, f)| std::iter::once(f.ruleset).chain(f.elements.iter().map(|e| e.ruleset)));
    for r in tags.flatten() {
        if !out.contains(&r) {
            out.push(r);
        }
    }
    out
}

/// A validation finding of converted Aurora content. The ID_UPPER_CASE id convention is
/// Borealis's (`docs/core-pack-ids.md`); Aurora keeps any id as written and so does the converter,
/// so an id off the convention changes nothing and is a note here (issue 8).
fn as_converted(issue: Issue) -> Issue {
    if issue.code == IssueCode::NonStandardId {
        Issue {
            severity: Severity::Info,
            ..issue
        }
    } else {
        issue
    }
}

fn validate_output(run: &mut Run<'_>) -> Result<(), MigrateError> {
    let mut builder = ContentStoreBuilder::new();
    for (rel, file) in &run.converted {
        builder = builder.add_file(rel.clone(), run.opts.origin, file.clone());
    }
    let issues = builder.build().validate();
    run.issues.extend(issues.into_iter().map(as_converted));

    for out in &run.outputs {
        // An `<index>` root saved as `.xml` is an index too: the manifest knows the real kind.
        let entry = run.manifest_files.iter().find(|(_, _, o)| *o == out.path);
        let source = entry.map_or_else(|| out.path.clone(), |(rel, _, _)| rel.clone());
        let kind = match entry {
            Some((_, PackFileKind::Index, _)) => DocumentKind::Index,
            Some(_) => DocumentKind::Content,
            None if out.path.ends_with(".index.json") => DocumentKind::Index,
            None => DocumentKind::Content,
        };
        let value: serde_json::Value = serde_json::from_str(&out.contents)?;
        for v in validate_document(kind, &value)? {
            run.issues.push(
                Issue::new(Severity::Error, IssueCode::SchemaViolation, v.to_string())
                    .in_file(source.clone()),
            );
        }
    }
    Ok(())
}

/// Write the output files under `dir`, creating directories as needed.
///
/// # Errors
/// [`MigrateError::Io`] on any filesystem failure.
pub fn write_output(dir: &Path, output: &MigrateOutput) -> Result<(), MigrateError> {
    for file in &output.files {
        let path = dir.join(&file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| MigrateError::io(parent, e))?;
        }
        std::fs::write(&path, &file.contents).map_err(|e| MigrateError::io(&path, e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_slugs() {
        assert_eq!(output_name("a/b.xml"), "a/b.json");
        assert_eq!(output_name("x.index"), "x.index.json");
        assert_eq!(output_name("Y.XML"), "Y.json");
        assert_eq!(slug("My Pack_v2!"), "my-pack-v2");
        assert_eq!(slug("!!!"), "migrated-pack");
        assert_eq!(index_content_dir("core.index"), "core");
        assert_eq!(index_content_dir("a/core.index"), "a/core");
    }

    #[test]
    fn os_metadata_is_not_content() {
        let tmp = std::env::temp_dir().join(format!("bm-walk-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("__MACOSX")).unwrap();
        std::fs::write(tmp.join("a.xml"), "<elements/>").unwrap();
        std::fs::write(tmp.join("._a.xml"), [0u8, 5, 22, 7]).unwrap();
        std::fs::write(tmp.join("__MACOSX/._a.xml"), [0u8]).unwrap();
        let mut found = Vec::new();
        walk(&tmp, &tmp, &mut found).unwrap();
        std::fs::remove_dir_all(&tmp).unwrap();
        assert_eq!(found, ["a.xml"]);
    }

    #[test]
    fn unsafe_entry_names() {
        assert!(safe_relative("a.xml"));
        assert!(safe_relative("sub/a.xml"));
        assert!(!safe_relative("../a.xml"));
        assert!(!safe_relative("/etc/passwd"));
        assert!(!safe_relative(""));
    }
}
