//! Persistent content preferences: disabled packs and the user's update indexes.

use crate::error::{ApiError, ApiResult};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// IM17: the stored value of a book set to Both editions.
const BOTH_EDITIONS: &str = "both";

/// A user-added update index (no defaults are ever shipped).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IndexRecord {
    /// HTTPS location of the index.
    pub url: String,
    /// Name from the last fetched index (the URL until then).
    pub name: String,
    /// RFC 3339 time of the last successful check.
    pub last_checked: Option<String>,
    /// Files listed by the last fetched index.
    pub file_count: usize,
    /// Listed files that differ from what is installed.
    pub updates_available: usize,
    /// The index asks for a newer app version.
    pub requires_newer_app: bool,
    /// Base64 ed25519 public key pinned on the first signed fetch (trust on first use).
    pub public_key: Option<String>,
    /// The last fetched index carried a valid signature from the pinned key.
    pub verified: bool,
    /// Aurora XML indexes: SHA-256 of every file at its first download (trust on first use);
    /// a later change is applied but reported.
    pub file_hashes: BTreeMap<String, String>,
    /// Aurora XML indexes: the ETag the server sent with every file that has one. Update sends it
    /// back, and a file answered "not modified" is read from the local copy instead of downloaded.
    pub file_etags: BTreeMap<String, String>,
    /// Hosts the index tree downloaded from at the last check.
    pub hosts: Vec<String>,
    /// Why the last check failed or was incomplete, for the Indexes list.
    pub problem: Option<String>,
}

/// Everything the Content screen persists besides the packs themselves.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentPrefs {
    /// Pack ids that are installed but switched off.
    pub disabled_packs: BTreeSet<String>,
    /// Update indexes added by the user.
    pub indexes: Vec<IndexRecord>,
    /// 5etools data folders imported from an address the user pasted.
    pub fivetools_urls: Vec<FiveToolsUrlRecord>,
    /// IM14 (GitHub #11): the edition the user set for an imported book, by
    /// [`borealis_content::source_key`] of its name: `"dnd2014"`, `"dnd2024"` or `"both"` (IM17). Applied when
    /// content loads; the imported files are never rewritten. Any JSON value is accepted, so a
    /// value of another shape a newer app writes never makes this file unreadable: it is ignored
    /// ([`Self::source_editions`]) and kept.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub source_editions: BTreeMap<String, serde_json::Value>,
    /// Keys a newer Borealis wrote that this one does not know: kept and written back.
    #[serde(flatten)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

/// A 5etools data folder imported from an address (GitHub repository or folder URL).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FiveToolsUrlRecord {
    /// The address as the user pasted it (trimmed).
    pub url: String,
    /// What was imported: the commit SHA (GitHub) or a digest of every file (folder address).
    pub revision: String,
    /// Folder addresses: every downloaded file with its ETag and SHA-256 (for Update).
    pub files: BTreeMap<String, crate::content_fivetools_remote::FileTag>,
    /// Source books the user chose; Update imports the same ones.
    pub sources: Vec<String>,
    pub include_fluff: bool,
    /// Packs the last import wrote.
    pub packs: Vec<String>,
    /// RFC 3339 times of the last check and the last import.
    pub last_checked: Option<String>,
    pub last_imported: Option<String>,
    /// Why the last Update failed.
    pub problem: Option<String>,
}

impl ContentPrefs {
    /// The book editions the user set, as rulesets (unknown values are skipped).
    #[must_use]
    pub fn source_editions(&self) -> BTreeMap<String, borealis_content::Ruleset> {
        self.source_editions
            .iter()
            .filter_map(|(k, v)| match v.as_str() {
                Some("dnd2014") => Some((k.clone(), borealis_content::Ruleset::Dnd2014)),
                Some("dnd2024") => Some((k.clone(), borealis_content::Ruleset::Dnd2024)),
                Some(BOTH_EDITIONS) => Some((k.clone(), borealis_content::Ruleset::Any)),
                _ => None,
            })
            .collect()
    }

    /// Set a book's edition by its name: `Dnd2014`, `Dnd2024` or `Any` (Both editions, IM17,
    /// stored as `"both"`).
    pub fn set_source_edition(&mut self, book: &str, edition: borealis_content::Ruleset) {
        let value = match edition {
            borealis_content::Ruleset::Any => BOTH_EDITIONS,
            other => other.as_str(),
        };
        self.source_editions.insert(
            borealis_content::source_key(book),
            serde_json::Value::String(value.to_string()),
        );
    }

    /// Read the file; a missing file means defaults. A file this version cannot read also means
    /// defaults, but it is copied to `<file>.bak` first (with a warning in the log), so the next
    /// save cannot destroy what it held (review M4).
    #[must_use]
    pub fn load(path: &Path) -> Self {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        match serde_json::from_str(&text) {
            Ok(prefs) => prefs,
            Err(e) => {
                let bak = path.with_extension("json.bak");
                let kept = std::fs::write(&bak, &text).is_ok();
                tracing::warn!(error = %e, kept, "content settings unreadable; using defaults");
                Self::default()
            }
        }
    }

    /// Write the file atomically.
    ///
    /// # Errors
    /// `io_error` if the file cannot be written.
    pub fn save(&self, path: &Path) -> ApiResult<()> {
        let text = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, text).map_err(|e| ApiError::io("save the content settings", e))?;
        borealis_character::format::replace_file(&tmp, path)
            .map_err(|e| ApiError::io("save the content settings", e))
    }
}
