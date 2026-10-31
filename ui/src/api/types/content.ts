import type { BookRuleset, ElementSummary, ElementType, Ruleset } from "./core";

export interface ItemSummary extends ElementSummary {
  category: string;
  costCp: number;
  weight: number;
  requiresAttunement: boolean;
  /** B-55 W3: present (true) when the item comes from bundled content (the SRD packs); orders the add-item list's default version. */
  bundled?: boolean;
}

/** One equipment-screen category and how many items the character can see in it (`list_item_categories`). */
export interface ItemCategory {
  name: string;
  count: number;
}

export interface ItemQuery {
  category?: string;
  query?: string;
  source?: string;
  limit?: number;
  offset?: number;
}

export interface CompendiumQuery {
  query: string;
  types?: ElementType[];
  sources?: string[];
  ruleset?: Ruleset | "any";
  limit: number;
  offset: number;
}

/** Keyword search scope (local-search-spec.md section 11); `sessions` stays hidden until campaigns exist. */
export type SearchScope = "all" | "rules" | "lore" | "sessions";

/** `search` request. */
export interface SearchQuery {
  scope: SearchScope;
  query: string;
  edition?: Ruleset | "any";
  campaign?: string;
  limit: number;
  offset: number;
  /** Contract element types to keep; `"rules"` keeps rules-text sections. */
  types?: (ElementType | "rules")[];
  sources?: string[];
}

/** One keyword search result. */
export interface SearchHit {
  /** Citation key: `<element id>[#n]` or `rules:<pack>/<section>[#n]`. */
  docKey: string;
  title: string;
  /** Heading path of a rules section (`Combat > Actions > Dash`); empty for elements. */
  path: string;
  /** Contract element type, or `"rules"` for a rules-text section. */
  type: ElementType | "rules";
  ruleset: Ruleset | null;
  /** Source display name. */
  source: string;
  snippet: string;
  /** `[start, end)` ranges in `snippet` (JavaScript string offsets). */
  highlights: [number, number][];
  /** The element to open; null for a rules section (`getSearchPassage`). */
  elementId: string | null;
}

/** A rules-text section with its licence attribution. */
export interface SearchPassage {
  docKey: string;
  title: string;
  path: string;
  /** Sanitised HTML. */
  html: string;
  source: string;
  ruleset: Ruleset;
  page: number | null;
  license: string;
  attribution: string;
}

/** Keyword index state (`search_index_status`, `search://index-status`). */
export interface SearchIndexStatus {
  state: "idle" | "building" | "ready" | "failed";
  done: number;
  total: number;
  message: string | null;
}

export interface Facet {
  id: string;
  label: string;
  count: number;
}
export interface CompendiumFacets {
  types: Facet[];
  sources: Facet[];
}

export type PackKind = "bundled" | "imported" | "downloaded" | "homebrew" | "local-import";

export interface ContentPack {
  id: string;
  name: string;
  version: string;
  kind: PackKind;
  rulesets: Ruleset[];
  elementCount: number;
  enabled: boolean;
  license: string;
  attribution: string;
  sourceIds: string[];
  /** false for packs converted from the user's own third-party data (shown as "Local import - not redistributable"). */
  redistributable?: boolean;
}

export interface ContentSource {
  id: string;
  name: string;
  group: string;
  packId: string;
  elementCount: number;
  description: string;
  playtest: boolean;
  /** The source is flagged incomplete (work in progress). */
  incomplete?: boolean;
  /** The source's own extra note; empty or absent when it has none. */
  info?: string;
  /** IM14: the book's edition as loaded (null when its content carries none; `any` = Both editions, IM17). */
  edition: BookRuleset | null;
  /** The edition is the user's choice (Sources page or import preview), not the importer's guess. */
  editionSetByUser: boolean;
  /** An imported book: its edition can be set. Bundled books are fixed. */
  editionEditable: boolean;
}

export type ContentFormat = "json" | "xml";

export interface ImportPackRequest {
  fileName: string;
  /** File bytes, base64 encoded (works identically in browser and Tauri). */
  contentBase64: string;
  /** Auto-detected from the extension/content when omitted. */
  format?: ContentFormat;
}

/** Closed set of conversion issue codes (Rust `borealis_content::IssueCode`, snake_case). */
export type MigrationIssueCode =
  | "xml_parse" | "missing_attribute" | "invalid_integer" | "invalid_boolean" | "invalid_version"
  | "unknown_rule_tag" | "unsupported_construct" | "element_dropped" | "duplicate_child" | "normalized"
  | "index_entry_missing" | "file_skipped" | "duplicate_id" | "element_replaced" | "invalid_id"
  | "non_standard_id" | "missing_required_setter" | "dangling_reference" | "invalid_expression"
  | "multiclass_id_same_as_class" | "append_target_missing" | "duplicate_select_name" | "undefined_source"
  | "schema_violation" | "invalid_monster_data" | "non_standard_monster_xp";

/** One conversion finding, located: source file (path inside the imported set), element id and type, line, code. */
export interface MigrationIssue {
  severity: "info" | "warning" | "error";
  element: string | null;
  message: string;
  code: MigrationIssueCode;
  /** The element's type in the source ("Spell", "Class Feature", ...). */
  elementType: string | null;
  /** Path of the source file inside the imported set (e.g. "classes/wizard.xml"). */
  file: string | null;
  line: number | null;
}

export interface MigrationReport {
  fileName: string;
  format: ContentFormat;
  converted: number;
  skipped: number;
  issues: MigrationIssue[];
}

export interface ImportPackResult {
  pack: ContentPack | null;
  report: MigrationReport;
}

export interface ContentIndex {
  url: string;
  name: string;
  lastChecked: string | null;
  fileCount: number;
  updatesAvailable: number;
  requiresNewerApp: boolean;
  /** Signed by the pinned key; false shows an "unverified" badge. */
  verified: boolean;
  /** Why the last check failed or was incomplete (e.g. "the server answered 404 Not Found for 3 files"). */
  problem: string | null;
}

export interface UpdateIndexesResult {
  updated: number;
  failed: string[];
  reloaded: boolean;
  /** Aurora index files whose content changed since their first download (applied, reported). */
  changed: string[];
  /** Hosts an index downloaded from for the first time. */
  newHosts: string[];
  /** One conversion report per pack this update converted (same shape as a file import's report). */
  reports: MigrationReport[];
}

export interface ContentProgress {
  phase: "checking" | "downloading" | "verifying" | "converting" | "reloading" | "done";
  done: number;
  total: number;
  message: string;
}

export interface RestrictionPreview {
  /** Current picks from a source the restriction would switch off. They stay chosen (the engine never removes a stored pick); only option lists narrow. */
  affected: { slotId: string; slotTitle: string; element: string }[];
}

/* ---------- 5etools local import ---------- */

/** Where a 5etools source is listed: `books.json`, `adventures.json`, a homebrew file's `_meta`, or nowhere. */
export type FiveToolsSourceCategory = "book" | "adventure" | "homebrew" | "other";

export interface FiveToolsSource {
  /** Book abbreviation as used by the data folder (e.g. "PHB", "XPHB"). */
  abbr: string;
  name: string;
  /** "mixed" when the source has entries of both editions. */
  ruleset: Ruleset | "mixed";
  category: FiveToolsSourceCategory;
  /** Element counts by type found for this book. */
  counts: Record<string, number>;
}

export interface FiveToolsScan {
  sources: FiveToolsSource[];
}

export interface FiveToolsImportRequest {
  /** `pickPath({ purpose: "5etools-folder" })` token. */
  folder: string;
  /** Selected `abbr` values. */
  sources: string[];
  includeFluff: boolean;
}

export interface ImportNote {
  element: string;
  /** Entity kind ("feat", "language", "subclass", ...). */
  kind: string;
  reason: string;
}

export interface FiveToolsImportReport {
  converted: number;
  /** Packs that already existed and were replaced in place (re-import). */
  replaced: number;
  partial: ImportNote[];
  skipped: ImportNote[];
  /** Packs installed into the user's library (kind "local-import", redistributable false). */
  packs: ContentPack[];
}

/** A 5etools data folder imported from an address the user pasted (`list_5etools_urls`). */
export interface FiveToolsUrl {
  /** GitHub repository or `data/` folder address, as pasted. */
  url: string;
  /** Short commit SHA (GitHub) or file digest (folder address) of the last import. */
  revision: string;
  /** Books chosen at the last import; Update imports the same ones. */
  sources: string[];
  packs: string[];
  lastChecked: string | null;
  lastImported: string | null;
  /** Why the last Update failed. */
  problem: string | null;
}

export interface FiveToolsUrlUpdate {
  /** The address has not changed; nothing was imported. */
  upToDate: boolean;
  /** The re-import, when it changed. */
  report: FiveToolsImportReport | null;
  urls: FiveToolsUrl[];
}
