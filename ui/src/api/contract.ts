/**
 * Backend contract between the Borealis UI and the Rust/Tauri side.
 *
 * Design rules:
 *  - Coarse-grained: every character mutation returns the full new `CharacterSnapshot`.
 *  - Each method maps to exactly one Tauri command (snake_case, see `COMMANDS`).
 *    The method's argument object is the invoke payload: its top-level keys are the command's
 *    named parameters (Tauri maps camelCase keys to snake_case Rust parameters).
 *  - Failures reject with an `ApiError`.
 *  - Streaming / push data uses `subscribe` (Tauri events, see `EVENTS`).
 */
import type {
  ClassCounts,
  AbilityKey,
  PlayTrackerReset,
  BundleExport,
  BundlePreview,
  BundleShare,
  LinkDevice,
  LinkSelection,
  LinkStatus,
  LinkSummary,
  AbilityMethod,
  AiEvent,
  AiHostStatus,
  AiInstallConsent,
  AiLoginHelp,
  AiSetupEvent,
  AiSetupProviderId,
  AiSetupStatus,
  AiMessage,
  AiMode,
  AiStatus,
  AiTaskHandle,
  AiTaskRequest,
  OptionDef,
  AppSettings,
  AppUpdateStatus,
  AppFolder,
  ClearCachesResult,
  ContentUpdateStatus,
  DataDirs,
  SecondaryContentResult,
  FileDrop,
  ImportFileInput,
  PickPurpose,
  PickedPath,
  CharacterDetails,
  CharacterOptions,
  CharacterSnapshot,
  CharacterSummary,
  CoinKey,
  CompanionState,
  CompendiumFacets,
  CompendiumQuery,
  SearchHit,
  SearchIndexStatus,
  SemanticDownload,
  SemanticIndexing,
  SemanticLicense,
  SemanticStatus,
  SearchPassage,
  SearchQuery,
  ContentIndex,
  ContentPack,
  ContentProgress,
  FiveToolsImportReport,
  FiveToolsUrl,
  FiveToolsUrlUpdate,
  ImportDraft,
  ImportEvent,
  ImportFinalizeRequest,
  ImportReportPreview,
  ImportReportRequest,
  ImportReportSent,
  ImportStartRequest,
  FiveToolsImportRequest,
  FiveToolsScan,
  ContentSource,
  ElementDetail,
  ElementSummary,
  EquipRequest,
  ExportResult,
  ImportPackRequest,
  ImportPackResult,
  ImportPreview,
  OpenedFile,
  PreviewImportRequest,
  ImportReport,
  RecheckReport,
  InventoryItem,
  ItemCategory,
  ItemQuery,
  ItemSummary,
  NewCharacterRequest,
  Page,
  RestrictionPreview,
  CompatibilityReport,
  RulesetProfile,
  SheetOptions,
  SheetPreview,
  StatTrace,
  Ruleset,
  BookRuleset,
  Unsubscribe,
  UpdateIndexesResult,
  ValidationReport,
  Attack,
  ConversionApplied,
  ConversionPreview,
} from "./types";

export * from "./types";

type Cid = { characterId: string };

export interface SlotOptionsArgs extends Cid {
  slotId: string;
  query?: string;
  limit?: number;
  offset?: number;
}
/** One offered option of a slot; also one version of a grouped row (B-55). */
export interface SlotOptionBase extends ElementSummary {
  /** Present when the option is shown but not choosable (e.g. unmet prerequisite). */
  disabledReason?: string;
  /** Present when the option comes from the other edition (a 2014 subclass on a 2024 class): the edition it was written for. */
  edition?: Ruleset;
  /** R6: present (true) when the edition adapter changed this other-edition option (the "converted" tag). */
  converted?: boolean;
  /** R6: the adapter's notes on an other-edition option (what it changed, or "used as written"). */
  editionNotes?: string[];
  /** B-55: present (true) when the element comes from bundled content (the SRD packs); orders the default version. */
  bundled?: boolean;
}
/** A picker row: one name (B-55, specs/version-rows-and-filters.md). Its own fields are its default version. */
export interface SlotOption extends SlotOptionBase {
  /** B-55: every offered version of this row in this slot, present only when there are two or more; versions[0] is the row's own. */
  versions?: SlotOptionBase[];
}
/** B-55: the result of switching a chosen row to another of its versions. */
export interface SwitchVersionResult {
  snapshot: CharacterSnapshot;
  /** Titles of sub-choices that did not fit the new version and need choosing again, in slot order. */
  dropped: string[];
}

/** All request/response commands. Keep in sync with `COMMANDS`. */
export interface ApiMethods {
  /* App */
  appVersion(): Promise<string>;

  /* Characters (library) */
  listCharacters(): Promise<CharacterSummary[]>;
  createCharacter(args: { request: NewCharacterRequest }): Promise<CharacterSnapshot>;
  loadCharacter(args: Cid): Promise<CharacterSnapshot>;
  getSnapshot(args: Cid): Promise<CharacterSnapshot>;
  /** Silent save to the existing path (autosave uses the same command). */
  saveCharacter(args: Cid): Promise<CharacterSnapshot>;
  /** Save As: with `name` a new library copy; without, the backend's native save dialog picks a `.json` file (desktop). */
  saveCharacterAs(args: Cid & { name?: string }): Promise<CharacterSnapshot>;
  closeCharacter(args: Cid & { discard: boolean }): Promise<void>;
  deleteCharacter(args: Cid): Promise<void>;
  duplicateCharacter(args: Cid): Promise<CharacterSummary>;
  updateCharacterMeta(
    args: Cid & { name?: string; group?: string; favorite?: boolean },
  ): Promise<CharacterSnapshot>;
  setPortrait(args: Cid & { dataUrl: string | null }): Promise<CharacterSnapshot>;
  /** Import a legacy `.dnd5e` (or native JSON) file from bytes. */
  importCharacter(args: { fileName: string; contentBase64: string }): Promise<ImportReport>;
  /** Retry imported characters' missing content against what is installed now (also runs after every content install). */
  recheckMissingContent(): Promise<RecheckReport>;
  exportCharacter(args: Cid): Promise<ExportResult>;

  /* Builder: selections */
  getSlotOptions(args: SlotOptionsArgs): Promise<Page<SlotOption>>;
  applySelection(args: Cid & { slotId: string; elementId: string }): Promise<CharacterSnapshot>;
  clearSelection(args: Cid & { slotId: string }): Promise<CharacterSnapshot>;
  /** B-55: switch the slot's current pick to another version of the same row, keeping sub-choices that still fit. */
  switchVersion(args: Cid & { slotId: string; elementId: string }): Promise<SwitchVersionResult>;
  replaceSpell(args: Cid & { slotId: string }): Promise<CharacterSnapshot>;

  /* Builder: levels */
  setXp(args: Cid & { xp: number }): Promise<CharacterSnapshot>;
  levelUp(args: Cid & { classSlotId: string }): Promise<CharacterSnapshot>;
  levelDown(args: Cid): Promise<CharacterSnapshot>;
  addMulticlass(args: Cid): Promise<CharacterSnapshot>;
  setHpRoll(args: Cid & { classSlotId: string; level: number; value: number }): Promise<CharacterSnapshot>;

  /* Builder: abilities (backend enforces budgets) */
  setAbilityMethod(args: Cid & { method: AbilityMethod }): Promise<CharacterSnapshot>;
  setBaseScore(args: Cid & { ability: AbilityKey; value: number }): Promise<CharacterSnapshot>;
  rollAbilities(args: Cid & { ability?: AbilityKey }): Promise<CharacterSnapshot>;
  /** Assign (or swap) a standard-array value; `value: null` unassigns. */
  assignStandardArray(
    args: Cid & { ability: AbilityKey; value: number | null },
  ): Promise<CharacterSnapshot>;
  resetAbilities(args: Cid): Promise<CharacterSnapshot>;

  /* Builder: options, restrictions, ruleset */
  setCharacterOptions(args: Cid & { options: Partial<CharacterOptions> }): Promise<CharacterSnapshot>;
  previewSourceRestrictions(args: Cid & { enabledSources: string[] | null }): Promise<RestrictionPreview>;
  setSourceRestrictions(args: Cid & { enabledSources: string[] | null }): Promise<CharacterSnapshot>;
  /** `allow: null` resets to the ruleset default (strict for 2014, open for 2024). Stored picks are never dropped. */
  setAllowCrossEdition(args: Cid & { allow: boolean | null }): Promise<CharacterSnapshot>;
  getCompatibilityReport(args: Cid): Promise<CompatibilityReport>;
  getRulesetProfile(args: { ruleset: Ruleset }): Promise<RulesetProfile>;
  /** Content options (the content's `Option` elements) a new character of `ruleset` can start with; the three built-ins are not listed. */
  listCharacterOptions(args: { ruleset: Ruleset }): Promise<OptionDef[]>;
  /** Classes a new character of each edition is offered with every source on (the New Character dialog warns at 0, U14). */
  classCountsByEdition(): Promise<ClassCounts>;
  /** "Start over as 2014" (U14): a NEW character of `ruleset` with this one's name, details, options, level, ability
   * method and scores and source choices, saved and opened. The old character's file is not changed. Throws
   * `invalid_argument` for `any` or the character's own edition. */
  startOverInEdition(args: Cid & { ruleset: Ruleset }): Promise<CharacterSnapshot>;

  /* Magic */
  setSpellPrepared(
    args: Cid & { classSlotId: string; spellId: string; prepared: boolean },
  ): Promise<CharacterSnapshot>;

  /* 2024: play state and Convert to 2024. All return the full snapshot (`play` block). */
  /** What converting a 2014 character would keep, map, drop or ask for. Saves nothing. */
  previewConvertTo2024(args: Cid): Promise<ConversionPreview>;
  /** Saves the converted copy as a new character and opens it; the original is untouched. */
  applyConvertTo2024(args: Cid): Promise<ConversionApplied>;
  spendResource(args: Cid & { resourceId: string; uses?: number }): Promise<CharacterSnapshot>;
  restoreResource(args: Cid & { resourceId: string; uses?: number }): Promise<CharacterSnapshot>;
  shortRest(args: Cid): Promise<CharacterSnapshot>;
  /** Refills resources, ends toggles, exhaustion -1 (2024). */
  longRest(args: Cid): Promise<CharacterSnapshot>;
  setToggle(args: Cid & { toggleId: string; on: boolean }): Promise<CharacterSnapshot>;
  setExhaustion(args: Cid & { level: number }): Promise<CharacterSnapshot>;
  setHeroicInspiration(args: Cid & { has: boolean }): Promise<CharacterSnapshot>;
  /* Spell tracker (GitHub #2). Rests are shortRest/longRest. Spends and restores are relative, like spendResource. */
  /** Marks `uses` (default 1) more slots of spell level `level` used; with `pact`, Pact Magic slots (`level` ignored). */
  spendSpellSlot(args: Cid & { level: number; pact?: boolean; uses?: number }): Promise<CharacterSnapshot>;
  /** Gives back `uses` (default 1) used slots, never below none used. */
  restoreSpellSlot(args: Cid & { level: number; pact?: boolean; uses?: number }): Promise<CharacterSnapshot>;
  /** Concentrate on a known or prepared concentration spell (replaces any other); null ends concentration. */
  setConcentration(args: Cid & { spellId: string | null }): Promise<CharacterSnapshot>;
  /** Adds a custom tracker: name 1-60 characters (bidi and zero-width characters are stripped), max 1-999. */
  addTracker(args: Cid & { name: string; max: number; reset: PlayTrackerReset; countsUp?: boolean }): Promise<CharacterSnapshot>;
  /** Renames a tracker or changes its maximum (the used count is clamped), reset or direction. */
  updateTracker(args: Cid & { trackerId: string; name: string; max: number; reset: PlayTrackerReset; countsUp?: boolean }): Promise<CharacterSnapshot>;
  removeTracker(args: Cid & { trackerId: string }): Promise<CharacterSnapshot>;
  /** Marks `uses` (default 1) more pips used (gained, for a tracker that counts up). */
  spendTracker(args: Cid & { trackerId: string; uses?: number }): Promise<CharacterSnapshot>;
  /** Gives back `uses` (default 1) pips, never below none used. */
  restoreTracker(args: Cid & { trackerId: string; uses?: number }): Promise<CharacterSnapshot>;
  /** Replaces all Weapon Mastery picks (in slot order; fewer ids leave slots open). */
  chooseWeaponMasteries(args: Cid & { weaponIds: string[] }): Promise<CharacterSnapshot>;
  setWildShapeForms(args: Cid & { formIds: string[] }): Promise<CharacterSnapshot>;
  /** Takes starting-equipment option `option` ("A", "B", ...) of a package from `play.equipmentPackages`. */
  chooseEquipmentPackage(args: Cid & { packageId: string; option: string }): Promise<CharacterSnapshot>;

  /* Equipment */
  /**
   * Item catalogue. With `characterId`: the items that character may use (its edition, plus another edition's items the
   * engine offers while strict mode is off, never one superseded by an equivalent; unrestricted sources). B-55 W3: one
   * entry per element; the add-item list groups same-name entries into one row.
   */
  searchItems(args: ItemQuery & { characterId?: string }): Promise<Page<ItemSummary>>;
  /** The equipment screen's categories for the character, in the classic builder's order, with row counts (one per name, B-55). */
  listItemCategories(args: Cid): Promise<ItemCategory[]>;
  /** The base items a generic magic weapon or armor can be added on, by name (the classic builder's second list); empty when it needs none. */
  listBaseItems(args: Cid & { itemId: string }): Promise<ItemSummary[]>;
  addItem(args: Cid & { itemId: string; quantity: number; buy: boolean; baseItemId?: string }): Promise<CharacterSnapshot>;
  removeItem(args: Cid & { inventoryId: string; all: boolean }): Promise<CharacterSnapshot>;
  equipItem(args: Cid & { inventoryId: string; slot: EquipRequest }): Promise<CharacterSnapshot>;
  unequipItem(args: Cid & { inventoryId: string }): Promise<CharacterSnapshot>;
  /** U12: switch "Override requirements" on a line (per item, saved with the character). */
  setItemRequirementsOverride(args: Cid & { inventoryId: string; on: boolean }): Promise<CharacterSnapshot>;
  setAttuned(args: Cid & { inventoryId: string; attuned: boolean }): Promise<CharacterSnapshot>;
  /** Enter the maximum of a dice-valued charge resource (`InventoryItem.rolledCharges`); refused outside min..max. */
  setRolledMax(args: Cid & { inventoryId: string; resourceId: string; value: number }): Promise<CharacterSnapshot>;
  /** Roll that maximum again. */
  rerollMax(args: Cid & { inventoryId: string; resourceId: string }): Promise<CharacterSnapshot>;
  storeItem(args: Cid & { inventoryId: string; storage: 0 | 1 | 2 }): Promise<CharacterSnapshot>;
  moveItem(args: Cid & { inventoryId: string; direction: "up" | "down" }): Promise<CharacterSnapshot>;
  updateItemDetails(
    args: Cid & {
      inventoryId: string;
      patch: Partial<Pick<InventoryItem, "displayName" | "notes" | "listInInventory" | "showCard">>;
    },
  ): Promise<CharacterSnapshot>;
  extractPack(args: Cid & { inventoryId: string }): Promise<CharacterSnapshot>;
  adjustCoins(args: Cid & { coin: CoinKey; delta: number }): Promise<CharacterSnapshot>;
  convertCoins(args: Cid & { to: CoinKey }): Promise<CharacterSnapshot>;
  setStorageNames(args: Cid & { names: [string, string] }): Promise<CharacterSnapshot>;

  /* Explain: the deterministic provenance trace of one statistic */
  explainStat(args: Cid & { stat: string }): Promise<StatTrace>;

  /* Manage */
  updateDetails(args: Cid & { patch: Partial<CharacterDetails> }): Promise<CharacterSnapshot>;
  upsertAttack(args: Cid & { attack: Omit<Attack, "id"> & { id?: string; asCard?: boolean } }): Promise<CharacterSnapshot>;
  removeAttack(args: Cid & { attackId: string }): Promise<CharacterSnapshot>;
  moveAttack(args: Cid & { attackId: string; direction: "up" | "down" }): Promise<CharacterSnapshot>;
  updateCompanion(args: Cid & { patch: Partial<Pick<CompanionState, "name" | "portrait">> }): Promise<CharacterSnapshot>;

  /* Sheet */
  renderSheet(args: Cid & { options?: SheetOptions }): Promise<SheetPreview>;
  exportSheet(args: Cid & { options?: SheetOptions }): Promise<ExportResult>;

  /* Compendium */
  searchCompendium(args: { query: CompendiumQuery }): Promise<Page<ElementSummary>>;
  getElement(args: { elementId: string }): Promise<ElementDetail>;
  compendiumFacets(): Promise<CompendiumFacets>;
  /** Keyword search over Rules, Lore or both (local-search-spec.md section 11). */
  search(args: { request: SearchQuery }): Promise<Page<SearchHit>>;
  searchIndexStatus(): Promise<SearchIndexStatus>;
  /** The rules-text section behind a `rules:` hit. */
  getSearchPassage(args: { docKey: string }): Promise<SearchPassage>;

  /* Semantic search model (Settings > Search, S3.2). Progress streams on `semantic:download`. */
  /** Tier, file, consent text and download state; reads the device only, never the network. */
  semanticStatus(): Promise<SemanticStatus>;
  /** The user accepted the consent dialog (or pressed Resume): download this device's file and turn semantic search on.
   * Throws `requirement_failed` when the device has no file or no URL serves it yet. */
  semanticDownloadStart(): Promise<SemanticStatus>;
  /** Pause; the partial is kept and Resume continues where it stopped. */
  semanticDownloadPause(): Promise<SemanticStatus>;
  /** Cancel: the partial is deleted and semantic search turns off. */
  semanticDownloadCancel(): Promise<SemanticStatus>;
  /** "Delete model and semantic indexes": model files and vectors go, keyword indexes stay, semantic search turns off. */
  semanticDeleteModel(): Promise<SemanticStatus>;
  /** The model's licence and NOTICE (Settings > About). */
  semanticModelLicense(): Promise<SemanticLicense>;

  /* Content */
  listPacks(): Promise<ContentPack[]>;
  importPack(args: { request: ImportPackRequest }): Promise<ImportPackResult>;
  /** Convert files or a picked folder without installing; `installImportPreview` then installs exactly that result. */
  previewImportPack(args: { request: PreviewImportRequest }): Promise<ImportPreview>;
  /** `editions` (IM14): the edition the user chose for books of the set, by book name; stored as each book's choice. */
  installImportPreview(args: { previewId: string; editions?: Record<string, BookRuleset> | null }): Promise<ImportPackResult>;
  cancelImportPreview(args: { previewId: string }): Promise<void>;
  /** Files the OS opened with the app (macOS/iOS/Android "open with" / share), oldest first. */
  takeOpenedFiles(): Promise<OpenedFile[]>;
  setPackEnabled(args: { packId: string; enabled: boolean }): Promise<ContentPack[]>;
  removePack(args: { packId: string }): Promise<ContentPack[]>;
  listSources(): Promise<ContentSource[]>;
  /** IM14: set an imported book's edition (2014 or 2024) and reload content. Characters already using the book keep its
   * content; new picks follow the edition. Refuses bundled books (`invalid_argument`) and unknown ones (`not_found`). */
  setSourceEdition(args: { sourceId: string; edition: BookRuleset }): Promise<ContentSource[]>;
  listIndexes(): Promise<ContentIndex[]>;
  addIndex(args: { url: string }): Promise<ContentIndex[]>;
  removeIndex(args: { url: string }): Promise<ContentIndex[]>;
  updateIndexes(): Promise<UpdateIndexesResult>;
  clearDownloadedContent(): Promise<ContentPack[]>;
  /** Read-only scan of the user's own 5etools `data/` folder; lists the source books found. */
  scan5etoolsFolder(args: { folder: string }): Promise<FiveToolsScan>;
  /** Unpack a `.zip` of the user's 5etools `data/` folder (phones have no folder picker; desktop accepts it too). Returns a `5etools-folder` token for `scan5etoolsFolder` and `import5etools`. */
  stage5etoolsZip(args: { file: ImportFileInput }): Promise<PickedPath>;
  /** Download the 5etools `data/` folder at an address the user pasted (a GitHub repository or any https:// folder address; none ships with the app). Emits `import5etools:progress` while downloading. Returns a `5etools-folder` token for `scan5etoolsFolder` and `import5etools`; importing from it remembers the address. */
  stage5etoolsUrl(args: { url: string }): Promise<PickedPath>;
  /** Addresses 5etools data was imported from. */
  list5etoolsUrls(): Promise<FiveToolsUrl[]>;
  /** Forget an address; its packs stay installed. */
  remove5etoolsUrl(args: { url: string }): Promise<FiveToolsUrl[]>;
  /** Check an address and re-import the same books only when it changed. */
  update5etoolsUrl(args: { url: string }): Promise<FiveToolsUrlUpdate>;
  /** Convert the chosen books and install the packs; emits `content:progress`. */
  import5etools(args: { request: FiveToolsImportRequest }): Promise<FiveToolsImportReport>;

  /* Settings */
  getSettings(): Promise<AppSettings>;
  /** `ai.overridePath` can only be resent unchanged or cleared (null) here; see `setAiOverride`. */
  saveSettings(args: { patch: Partial<AppSettings> }): Promise<AppSettings>;

  /* Native pickers, opened by the backend; `[]` when cancelled. `startDir` only positions the dialog. */
  pickPath(args: { purpose: PickPurpose; startDir?: string }): Promise<PickedPath[]>;
  /** Read `character-file` picks or `dropped-file` tokens (from `files:dropped`); each token works once. */
  takePickedFiles(args: { purpose: PickPurpose; tokens: string[] }): Promise<OpenedFile[]>;
  /** Use an `ai-override` pick as the AI program after validation and a native confirmation; a declined confirmation returns the settings unchanged. */
  setAiOverride(args: { token: string }): Promise<AppSettings>;

  /* Settings > DATA FILES and the classic builder's deferred apply (Save = `saveSettings` with the full form, Cancel = `getSettings`). */
  /** Current documents / characters / secondary folders (display only). */
  getDataDirs(): Promise<DataDirs>;
  /** Use a `documents-dir` pick; omit `token` to go back to the default folder. Existing characters are not moved. */
  setDocumentsDir(args: { token?: string }): Promise<DataDirs>;
  /** Link a `secondary-content-dir` pick and load its .xml/.json files as `sec-*` user packs (hot-reload). */
  setSecondaryContentDir(args: { token: string }): Promise<SecondaryContentResult>;
  /** Classic builder "UNLINK SECONDARY DIRECTORY": forget the folder and remove its packs (hot-reload). */
  unlinkSecondaryContentDir(): Promise<SecondaryContentResult>;
  /** Classic builder "Restore Defaults": reset and save at once (AI, default ruleset and autosave are kept). */
  restoreDefaultSettings(): Promise<AppSettings>;
  /** Classic builder "Clear News Articles Cache" mapped to Borealis's caches (scratch folders, AI temp folders, index check results). Immediate, no Save needed. */
  clearCaches(): Promise<ClearCachesResult>;
  /** Outcome of the automatic content update at startup. */
  contentUpdateStatus(): Promise<ContentUpdateStatus>;
  /** Outcome of the startup "new version available" check (`unsupported` on phones, where the UI asks GitHub itself). */
  appUpdateStatus(): Promise<AppUpdateStatus>;
  /** "Check now": ask GitHub for the latest Borealis version right away (desktop; `unsupported` on phones). */
  checkAppUpdate(): Promise<AppUpdateStatus>;
  /** Open the official download page in the default browser (desktop; phones fail and the UI opens it). */
  openDownloadPage(): Promise<void>;
  /** Open one of the app's fixed web pages (Help menu, globe, download page; `lib/links.ts`) in the system browser on
   * every platform (U15). Any other address is refused with `invalid_argument`. */
  openLink(args: { url: string }): Promise<void>;
  /** Open an app-owned folder in the OS file manager. The backend resolves the path; the UI never sends one. */
  openAppFolder(args: { folder: AppFolder }): Promise<void>;
  /** The newest log lines (home folder shown as `~`), for sharing from a phone, which has no folder to open. */
  getRecentLogs(): Promise<string>;
  /** Android (no Web Share in its web view): send the newest log lines to the system share sheet as a file. Elsewhere it fails with "not available". */
  shareLogs(): Promise<void>;
  /** Restart the application so new content loads. */
  restartApp(): Promise<void>;
  /** B-48 O13: whether the system setting lets the app play light haptics (Android's touch feedback; always on iOS, never on desktop). */
  hapticsEnabled(): Promise<boolean>;
  /** Debug builds only (S5 acceptance): per-type counts and digests of the loaded content and of 12 fixed characters built from it. Release builds have no such command. */
  acceptanceDigest(): Promise<Record<string, unknown>>;

  /* AI */
  aiStatus(): Promise<AiStatus>;
  aiStartTask(args: { request: AiTaskRequest }): Promise<AiTaskHandle>;
  aiCancelTask(args: { taskId: string }): Promise<void>;
  aiValidateHomebrew(args: { json: Record<string, unknown> }): Promise<ValidationReport>;
  aiAddHomebrewToPack(args: { json: Record<string, unknown>; packId?: string }): Promise<ContentPack>;
  /** Desktop LAN host (see `AiHostStatus`). */
  /** Throws `consent_required` when only Codex is installed; retry with `allowUntrustedWithCodex: true` after the user agrees. */
  aiHostEnable(args?: { allowUntrustedWithCodex?: boolean }): Promise<AiHostStatus>;
  aiHostDisable(): Promise<AiHostStatus>;
  aiHostStatus(): Promise<AiHostStatus>;
  aiHostBeginPairing(): Promise<AiHostStatus>;
  aiHostRevoke(args: { deviceId: string }): Promise<AiHostStatus>;

  /* Device transfer ("Send to device" / "Receive from device"); updates stream on `link:status`.
   * The device that shows the QR / code listens (only while the dialog is open, 5 minutes, one attempt). */
  /** Open a window to send `selection`: returns the QR payload, the typed code and the address to show. */
  linkStartSend(args: { selection: LinkSelection }): Promise<LinkStatus>;
  /** Open a window to receive. */
  linkStartReceive(): Promise<LinkStatus>;
  /** Connect to another device's window: `target` is a scanned `borealis-link:v1?...` payload or a typed code; `host` (`ip:port`) goes with a code where discovery is unavailable. With `selection` this device sends. */
  linkConnect(args: { target: string; host?: string; selection?: LinkSelection }): Promise<LinkStatus>;
  linkStatus(args: { sessionId: string }): Promise<LinkStatus>;
  /** Receiver: accept the previewed items. */
  linkAccept(args: { sessionId: string }): Promise<LinkStatus>;
  linkDecline(args: { sessionId: string }): Promise<LinkStatus>;
  /** Close the window or stop the transfer; nothing partial is kept. */
  linkCancel(args: { sessionId: string }): Promise<LinkStatus>;
  /** Settings > Devices: paired devices, most recently synced first (expired pairings are dropped). */
  linkDevices(): Promise<LinkDevice[]>;
  /** Remove a device: its key is refused from now on. Returns the remaining list. */
  linkForgetDevice(args: { deviceId: string }): Promise<LinkDevice[]>;

  /* Bundles as files (Stage 0, no network): the same `borealis-bundle/1` a device transfer sends. */
  /** Desktop: build a bundle of `selection` and save it where the native save dialog says; `path` is null when cancelled. */
  bundleExport(args: { selection: LinkSelection }): Promise<BundleExport>;
  /** Phones: build a bundle and open the system share sheet (Android from the backend; elsewhere `dataBase64` is for the web view's share sheet). */
  bundleShare(args: { selection: LinkSelection }): Promise<BundleShare>;
  /** Preview a `.borealis` file (a `bundle-file` token from `pickPath`, a drop or `takeOpenedBundles`). Throws a plain message for a damaged, oversize or foreign file; nothing is written. */
  bundleOpen(args: { token: string }): Promise<BundlePreview>;
  /** Apply a previewed bundle through the same validated path as a device transfer (newest edit wins; replaced copies go to the sync trash for 30 days). */
  bundleAccept(args: { bundleId: string }): Promise<LinkSummary>;
  /** Close a previewed bundle without applying it. */
  bundleDiscard(args: { bundleId: string }): Promise<void>;
  /** `.borealis` files the OS opened with the app, as `bundle-file` tokens. Call after `takeOpenedFiles`. */
  takeOpenedBundles(): Promise<PickedPath[]>;

  /* First-run AI setup (desktop). Install output streams on `aisetup:event`. */
  aiSetupStatus(): Promise<AiSetupStatus>;
  /** Step 1 of an install: the UI calls this only after the user accepts the consent dialog. */
  aiSetupConfirmInstall(args: { provider: AiSetupProviderId }): Promise<AiInstallConsent>;
  /** Step 2: runs the official install; refused without a valid one-time `consentToken`. */
  aiSetupInstall(args: { provider: AiSetupProviderId; consentToken: string }): Promise<void>;
  /** Shows the sign-in command; `openTerminal` opens a terminal with it where supported. Borealis never handles credentials. */
  aiSetupLogin(args: { provider: AiSetupProviderId; openTerminal?: boolean }): Promise<AiLoginHelp>;
  /** Remember that the first-run screen was finished (or skipped). */
  aiSetupComplete(args: { skipped?: boolean }): Promise<void>;

  /* Import anything; progress streams over `import:event` */
  importStart(args: ImportStartRequest): Promise<{ draftId: string }>;
  importGetDraft(args: { draftId: string }): Promise<ImportDraft>;
  importChooseParent(args: { draftId: string; classId: string; allowUntrustedWithCodex?: boolean }): Promise<ImportDraft>;
  /** Streams; `elementId` limits the instruction to one element (the per-element "fix with AI"). Resolves once the revision is accepted. */
  importRevise(args: { draftId: string; instruction: string; elementId?: string; allowUntrustedWithCodex?: boolean }): Promise<void>;
  /** Manual JSON edit; the element is re-validated and returned inside the draft. */
  importUpdateElement(args: { draftId: string; elementId: string; json: Record<string, unknown> }): Promise<ImportDraft>;
  /** Mark an element that needs checking as fine (or undo that). */
  importAcceptElement(args: { draftId: string; elementId: string; accepted: boolean }): Promise<ImportDraft>;
  /** Force an element to text only (true), to full rules (false), or back to automatic (null). */
  importSetTextOnly(args: { draftId: string; elementId: string; textOnly: boolean | null }): Promise<ImportDraft>;
  /** Streams like importRevise (ends with stage "ready" or "error"; then call importGetDraft): generate the element again from the given source lines (the generation path, not a revision). */
  importRelocateElement(args: { draftId: string; elementId: string; startLine: number; endLine: number; allowUntrustedWithCodex?: boolean }): Promise<void>;
  /** Streams like importRelocateElement: generate the element again from its current passage. The draft is unchanged when the model call fails. */
  importRegenerateElement(args: { draftId: string; elementId: string; allowUntrustedWithCodex?: boolean }): Promise<void>;
  importFinalize(args: { draftId: string } & ImportFinalizeRequest): Promise<ContentPack>;
  importDiscard(args: { draftId: string }): Promise<void>;
  /** Builds the opt-in bug report and keeps it for sending; sends nothing. */
  importReportPreview(args: ImportReportRequest): Promise<ImportReportPreview>;
  /** Sends exactly the previewed payload (HTTPS POST to the Borealis website). */
  importReportSend(args: { previewId: string }): Promise<ImportReportSent>;
}

export type CommandName = keyof ApiMethods;

/** Method name -> Tauri command name. Completeness enforced by the type. */
export const COMMANDS = {
  appVersion: "app_version",
  listCharacters: "list_characters",
  createCharacter: "create_character",
  loadCharacter: "load_character",
  getSnapshot: "get_snapshot",
  saveCharacter: "save_character",
  saveCharacterAs: "save_character_as",
  closeCharacter: "close_character",
  deleteCharacter: "delete_character",
  duplicateCharacter: "duplicate_character",
  updateCharacterMeta: "update_character_meta",
  setPortrait: "set_portrait",
  importCharacter: "import_character",
  recheckMissingContent: "recheck_missing_content",
  exportCharacter: "export_character",
  getSlotOptions: "get_slot_options",
  applySelection: "apply_selection",
  clearSelection: "clear_selection",
  switchVersion: "switch_version",
  replaceSpell: "replace_spell",
  setXp: "set_xp",
  levelUp: "level_up",
  levelDown: "level_down",
  addMulticlass: "add_multiclass",
  setHpRoll: "set_hp_roll",
  setAbilityMethod: "set_ability_method",
  setBaseScore: "set_base_score",
  rollAbilities: "roll_abilities",
  assignStandardArray: "assign_standard_array",
  resetAbilities: "reset_abilities",
  setCharacterOptions: "set_character_options",
  previewSourceRestrictions: "preview_source_restrictions",
  setSourceRestrictions: "set_source_restrictions",
  setAllowCrossEdition: "set_allow_cross_edition",
  getCompatibilityReport: "get_compatibility_report",
  getRulesetProfile: "get_ruleset_profile",
  listCharacterOptions: "list_character_options",
  classCountsByEdition: "class_counts_by_edition",
  startOverInEdition: "start_over_in_edition",
  setSpellPrepared: "set_spell_prepared",
  previewConvertTo2024: "preview_convert_to_2024",
  applyConvertTo2024: "apply_convert_to_2024",
  spendResource: "spend_resource",
  restoreResource: "restore_resource",
  shortRest: "short_rest",
  longRest: "long_rest",
  setToggle: "set_toggle",
  setExhaustion: "set_exhaustion",
  setHeroicInspiration: "set_heroic_inspiration",
  spendSpellSlot: "spend_spell_slot",
  restoreSpellSlot: "restore_spell_slot",
  setConcentration: "set_concentration",
  addTracker: "add_tracker",
  updateTracker: "update_tracker",
  removeTracker: "remove_tracker",
  spendTracker: "spend_tracker",
  restoreTracker: "restore_tracker",
  chooseWeaponMasteries: "choose_weapon_masteries",
  setWildShapeForms: "set_wild_shape_forms",
  chooseEquipmentPackage: "choose_equipment_package",
  searchItems: "search_items",
  listItemCategories: "list_item_categories",
  listBaseItems: "list_base_items",
  addItem: "add_item",
  removeItem: "remove_item",
  equipItem: "equip_item",
  unequipItem: "unequip_item",
  setItemRequirementsOverride: "set_item_requirements_override",
  setAttuned: "set_attuned",
  setRolledMax: "set_rolled_max",
  rerollMax: "reroll_max",
  storeItem: "store_item",
  moveItem: "move_item",
  updateItemDetails: "update_item_details",
  extractPack: "extract_pack",
  adjustCoins: "adjust_coins",
  convertCoins: "convert_coins",
  setStorageNames: "set_storage_names",
  explainStat: "explain_stat",
  updateDetails: "update_details",
  upsertAttack: "upsert_attack",
  removeAttack: "remove_attack",
  moveAttack: "move_attack",
  updateCompanion: "update_companion",
  renderSheet: "render_sheet",
  exportSheet: "export_sheet",
  searchCompendium: "search_compendium",
  getElement: "get_element",
  compendiumFacets: "compendium_facets",
  search: "search",
  searchIndexStatus: "search_index_status",
  getSearchPassage: "get_search_passage",
  semanticStatus: "semantic_status",
  semanticDownloadStart: "semantic_download_start",
  semanticDownloadPause: "semantic_download_pause",
  semanticDownloadCancel: "semantic_download_cancel",
  semanticDeleteModel: "semantic_delete_model",
  semanticModelLicense: "semantic_model_license",
  listPacks: "list_packs",
  importPack: "import_pack",
  previewImportPack: "preview_import_pack",
  installImportPreview: "install_import_preview",
  cancelImportPreview: "cancel_import_preview",
  takeOpenedFiles: "take_opened_files",
  setPackEnabled: "set_pack_enabled",
  removePack: "remove_pack",
  listSources: "list_sources",
  setSourceEdition: "set_source_edition",
  listIndexes: "list_indexes",
  addIndex: "add_index",
  removeIndex: "remove_index",
  updateIndexes: "update_indexes",
  clearDownloadedContent: "clear_downloaded_content",
  scan5etoolsFolder: "scan_5etools_folder",
  stage5etoolsZip: "stage_5etools_zip",
  stage5etoolsUrl: "stage_5etools_url",
  list5etoolsUrls: "list_5etools_urls",
  remove5etoolsUrl: "remove_5etools_url",
  update5etoolsUrl: "update_5etools_url",
  import5etools: "import_5etools",
  getSettings: "get_settings",
  saveSettings: "save_settings",
  pickPath: "pick_path",
  takePickedFiles: "take_picked_files",
  setAiOverride: "set_ai_override",
  getDataDirs: "get_data_dirs",
  setDocumentsDir: "set_documents_dir",
  setSecondaryContentDir: "set_secondary_content_dir",
  unlinkSecondaryContentDir: "unlink_secondary_content_dir",
  restoreDefaultSettings: "restore_default_settings",
  clearCaches: "clear_caches",
  contentUpdateStatus: "content_update_status",
  appUpdateStatus: "app_update_status",
  checkAppUpdate: "check_app_update",
  openDownloadPage: "open_download_page",
  openLink: "open_link",
  openAppFolder: "open_app_folder",
  getRecentLogs: "get_recent_logs",
  shareLogs: "share_logs",
  restartApp: "restart_app",
  hapticsEnabled: "haptics_enabled",
  acceptanceDigest: "acceptance_digest",
  aiStatus: "ai_status",
  aiStartTask: "ai_start_task",
  aiCancelTask: "ai_cancel_task",
  aiValidateHomebrew: "ai_validate_homebrew",
  aiAddHomebrewToPack: "ai_add_homebrew_to_pack",
  aiHostEnable: "ai_host_enable",
  aiHostDisable: "ai_host_disable",
  aiHostStatus: "ai_host_status",
  aiHostBeginPairing: "ai_host_begin_pairing",
  aiHostRevoke: "ai_host_revoke",
  linkStartSend: "link_start_send",
  linkStartReceive: "link_start_receive",
  linkConnect: "link_connect",
  linkStatus: "link_status",
  linkAccept: "link_accept",
  linkDecline: "link_decline",
  linkCancel: "link_cancel",
  linkDevices: "link_devices",
  linkForgetDevice: "link_forget_device",
  bundleExport: "bundle_export",
  bundleShare: "bundle_share",
  bundleOpen: "bundle_open",
  bundleAccept: "bundle_accept",
  bundleDiscard: "bundle_discard",
  takeOpenedBundles: "take_opened_bundles",
  aiSetupStatus: "ai_setup_status",
  aiSetupConfirmInstall: "ai_setup_confirm_install",
  aiSetupInstall: "ai_setup_install",
  aiSetupLogin: "ai_setup_login",
  aiSetupComplete: "ai_setup_complete",
  importStart: "import_start",
  importGetDraft: "import_get_draft",
  importChooseParent: "import_choose_parent",
  importRevise: "import_revise",
  importUpdateElement: "import_update_element",
  importAcceptElement: "import_accept_element",
  importSetTextOnly: "import_set_text_only",
  importRelocateElement: "import_relocate_element",
  importRegenerateElement: "import_regenerate_element",
  importFinalize: "import_finalize",
  importDiscard: "import_discard",
  importReportPreview: "import_report_preview",
  importReportSend: "import_report_send",
} as const satisfies Record<CommandName, string>;

/** Backend -> UI push events (Tauri `emit`). */
export interface ApiEvents {
  "ai:event": AiEvent;
  "aisetup:event": AiSetupEvent;
  "import:event": ImportEvent;
  "content:progress": ContentProgress;
  /** The "new version available" check finished. */
  "appupdate:status": AppUpdateStatus;
  /** 5etools import progress (`import_5etools_progress`). */
  "import5etools:progress": ContentProgress;
  /** Content store hot-reloaded: UI should refetch packs, catalogues and open slot options. */
  "content:reloaded": { reason: string };
  /** The OS handed the app a file; collect it with `takeOpenedFiles`. */
  "content:open-file": Record<string, never>;
  /** Files dropped on the window from the OS: tokens and names only; read them with `takePickedFiles`. */
  "files:dropped": FileDrop;
  /** Keyword index build / update progress. */
  "search:index-status": SearchIndexStatus;
  /** Semantic model download progress (start, pause, cancel, verify, done, failure). */
  "semantic:download": SemanticDownload;
  /** Semantic index progress (loading the model, indexing, paused, ready, disabled by the NaN guard). */
  "semantic:index": SemanticIndexing;
  /** A device transfer session changed (phase, preview, progress, result). */
  "link:status": LinkStatus;
}
export type EventName = keyof ApiEvents;

/** Tauri event names for `ApiEvents`. */
export const EVENTS = {
  "ai:event": "borealis://ai-event",
  "aisetup:event": "borealis://ai-setup-event",
  "import:event": "borealis://import-event",
  "content:progress": "borealis://content-progress",
  "appupdate:status": "borealis://app-update",
  "import5etools:progress": "borealis://import_5etools_progress",
  "content:reloaded": "borealis://content-reloaded",
  "content:open-file": "borealis://open-file",
  "files:dropped": "borealis://file-drop",
  "search:index-status": "search://index-status",
  "semantic:download": "borealis://semantic-download",
  "semantic:index": "borealis://semantic-index",
  "link:status": "borealis://link-status",
} as const satisfies Record<EventName, string>;

export interface Api extends ApiMethods {
  subscribe<E extends EventName>(event: E, handler: (payload: ApiEvents[E]) => void): Unsubscribe;
  /** "mock" when no backend is attached (browser dev / tests). */
  readonly kind: "tauri" | "mock";
}

/** Convenience re-exports for UI code. */
export type { AiMessage, AiMode };
