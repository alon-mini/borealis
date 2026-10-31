import type { Api, ApiEvents, BookRuleset, EventName, Ruleset, SlotOption, SlotOptionsArgs, SwitchVersionResult } from "../contract";
import type {
  AiHostStatus,
  LinkDevice,
  LinkSelection,
  AppSettings, Attack, CharacterSnapshot, CharacterSummary, ExportResult, ImportReport, ItemSummary, MissingContentItem, Page, RecheckReport, RestrictionPreview, CompatibilityReport,
  AiSetupProviderId, ImportFileInput, OpenedFile, PickPurpose, RulesetProfile, SheetPreview, StatTrace, Unsubscribe,
} from "../types";
import { MockAi } from "./ai";
import { MockAiSetup, type MockSetupInit } from "./ai-setup";
import { MockImport } from "./import";
import { MockPicks } from "./picks";
import { MockFiveToolsUrls } from "./fivetools-urls";
import { MockImportPreview } from "./import-preview";
import { MockImportReports } from "./import-report";
import * as rolled from "./rolled-charges";
import { MockAppUpdate, recordOpenedLink } from "./app-update";
import { classCounts, setClasslessEdition, startedOver } from "./edition-classes";
import { MockDataFiles } from "./data-files";
import { MockBundles } from "./bundles";
import { MockDeviceLink } from "./link";
import { MockSemantic, type MockSemanticOptions } from "./semantic";
import { validateHomebrew } from "./ai";
import { ContentService, OPEN_SCOPE, type ItemScope } from "./content-service";
import { getClass, getElement } from "./content";
import { DEFAULT_SETTINGS } from "./default-settings";
import { apiError } from "./errors";
import { SAMPLE_CONTENT_NOTICES, createCharacter, seedLibrary } from "./library";
import * as abil from "./ops-abilities";
import * as eq from "./ops-equipment";
import * as lv from "./ops-levels";
import * as play from "./play";
import * as track from "./spell-tracker";
import { renderSheetHtml } from "./sheet";
import { buildSlotDefs } from "./slots";
import { DEFAULT_PAGE, groupRows, queryRows, switchVersionChoices, toVersion } from "./slot-options";
import { OPTION_DEFS, buildName, buildSnapshot } from "./snapshot";
import { type MockCharacter, type RuleSettings, levelOf } from "./state";
import { findByWireId, toWireSlotId } from "./slot-ids";
import { MOCK_INDEX_STATUS, mockPassage, mockSearch } from "./search";

export interface MockApiOptions {
  /** Artificial latency per call in ms (default 0). */
  latencyMs?: number;
  seed?: boolean;
  rng?: () => number;
  aiChunkDelayMs?: number;
  aiAvailable?: boolean;
  /** Initial first-run setup state (default: nothing installed, npm present). */
  aiSetup?: Partial<MockSetupInit>;
  /** Delay between simulated import stages in ms (default 300). */
  importStepMs?: number;
  /** Only Codex is installed: outside content and the LAN host answer `consent_required` until the user agrees. */
  codexOnly?: boolean;
  /** Starts with the optional AI assistant switched on (default off, like a fresh install). */
  aiEnabled?: boolean;
  /** Simulates an iOS/Android build: `settings.mobile` is true and AI is forced off. */
  mobile?: boolean;
  /** Device transfer: a simulated other device connects to an open Send/Receive window after this many ms (default: never). */
  linkPeerAfterMs?: number | null;
  /** Device transfer: paired devices to start with (Settings > Devices). */
  linkDevices?: LinkDevice[];
  /** The file name the first "Open bundle..." picks (default `Mira.borealis`). */
  bundleFile?: string | null;
  /** Semantic search model (Settings > Search): tier, backend, mirror, an installed model, step delay. */
  semantic?: Partial<MockSemanticOptions>;
  /** U14 scenario: this edition has no classes (as with every book of it switched off). */
  classlessEdition?: Ruleset | null;
  /** C1 scenario (GitHub #11): the seeded characters carry content notices, as with a large homebrew set installed. */
  contentNotices?: boolean;
}

const PROFILES: Record<"dnd2014" | "dnd2024", RulesetProfile> = {
  dnd2014: { id: "dnd2014", label: "2014 (SRD 5.1)", srdSource: "SRD 5.1", terminology: { species: "Race", armorTraining: "Armor proficiency", inspiration: "Inspiration" },
    abilityMethods: ["point_buy", "standard_array", "roll_4d6", "roll_3d6", "manual"], abilityCap: 20, pointBuyBudget: 27, weaponMastery: false, originFeats: false, backgroundAsi: false },
  dnd2024: { id: "dnd2024", label: "2024 (SRD 5.2)", srdSource: "SRD 5.2.1", terminology: { species: "Species", armorTraining: "Armor training", inspiration: "Heroic Inspiration" },
    abilityMethods: ["point_buy", "standard_array", "roll_4d6", "manual"], abilityCap: 20, pointBuyBudget: 27, weaponMastery: true, originFeats: true, backgroundAsi: true },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

export class MockApi implements Api {
  readonly kind = "mock" as const;
  private chars = new Map<string, MockCharacter>();
  /** Missing content per imported character (the mock's stand-in for the backend's import record). */
  private missingByChar = new Map<string, MissingContentItem[]>();
  private contentAvailable = false;
  private saved = new Map<string, MockCharacter>();
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private handlers = new Map<EventName, Set<(p: never) => void>>();
  private content: ContentService;
  private ai: MockAi;
  private setup: MockAiSetup;
  private imp: MockImport;
  /** Mock native dialogs (`pickPath`); tests may set `picks.next`. */
  readonly picks = new MockPicks();
  readonly fivetoolsUrls = new MockFiveToolsUrls();
  /** Opt-in import bug reports; tests read `reports.sent` or set `reports.failSend`. */
  readonly reports = new MockImportReports();
  private dataFiles = new MockDataFiles(this.picks);
  readonly appUpdate = new MockAppUpdate();
  private rng: () => number;
  private latency: number;
  private codexOnly: boolean;
  private mobile: boolean;
  /** Imports the user agreed to run on Codex (asked once per import). */
  private consented = new Set<string>();

  constructor(opts: MockApiOptions = {}) {
    this.latency = opts.latencyMs ?? 0;
    this.codexOnly = opts.codexOnly ?? false;
    this.mobile = opts.mobile ?? false;
    this.settings = { ...this.settings, mobile: this.mobile, ai: { ...this.settings.ai, enabled: !this.mobile && (opts.aiEnabled ?? false) } };
    this.rng = opts.rng ?? Math.random;
    setClasslessEdition(opts.classlessEdition ?? null);
    this.content = new ContentService((p) => this.emit("content:progress", p), () => this.emit("content:reloaded", { reason: "content changed" }), (p) => this.emit("import5etools:progress", p));
    this.ai = new MockAi((e) => this.emit("ai:event", e), { chunkDelayMs: opts.aiChunkDelayMs ?? 25, available: opts.aiAvailable ?? true });
    this.setup = new MockAiSetup((e) => this.emit("aisetup:event", e), opts.aiSetup);
    this.imp = new MockImport((e) => this.emit("import:event", e), opts.importStepMs ?? 300);
    this.link = new MockDeviceLink((st) => this.emit("link:status", st), {
      mobile: this.mobile, peerAfterMs: opts.linkPeerAfterMs ?? null, devices: opts.linkDevices,
      onReceived: (names) => this.addReceived(names),
    });
    this.semantic = new MockSemantic((d) => this.emit("semantic:download", d), this.mobile, opts.semantic, (i) => this.emit("semantic:index", i));
    if (opts.bundleFile) this.picks.next = `/home/me/Downloads/${opts.bundleFile.replace(/[^A-Za-z0-9 ._-]/g, "_")}`;
    this.bundles = new MockBundles((token) => this.picks.take(token, "bundle-file"), (path) => this.picks.grantBundle(path), (names) => this.addReceived(names));
    if (opts.seed !== false) for (const c of seedLibrary(opts.contentNotices ? SAMPLE_CONTENT_NOTICES : [])) { this.chars.set(c.id, c); this.saved.set(c.id, c); }
  }

  /* ---------- infrastructure ---------- */

  subscribe<E extends EventName>(event: E, handler: (p: ApiEvents[E]) => void): Unsubscribe {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (p: never) => void);
    this.handlers.set(event, set);
    return () => set.delete(handler as (p: never) => void);
  }

  private emit<E extends EventName>(event: E, payload: ApiEvents[E]): void {
    this.handlers.get(event)?.forEach((h) => h(payload as never));
  }

  private async tick(): Promise<void> {
    if (this.latency) await sleep(this.latency);
  }

  private get rules(): RuleSettings {
    const s = this.settings;
    return { pointBuyBudget: s.pointBuyBudget, minBase: s.abilityMinBase, maxBase: s.abilityMaxBase, capEnabled: s.abilityCapEnabled };
  }

  private get(id: string): MockCharacter {
    const c = this.chars.get(id);
    if (!c) throw apiError("not_found", `Unknown character ${id}`);
    return c;
  }

  private snap(c: MockCharacter): CharacterSnapshot {
    const { character, snapshot } = buildSnapshot(c, this.rules);
    this.chars.set(character.id, character);
    return snapshot;
  }

  /** Runs a pure update, marks the character dirty, clears transient warnings, returns the snapshot. */
  private async mutate(id: string, fn: (c: MockCharacter) => MockCharacter): Promise<CharacterSnapshot> {
    await this.tick();
    const cur = this.get(id);
    const next = fn({ ...cur, warnings: [] });
    return this.snap({ ...next, dirty: true, updatedAt: new Date().toISOString() });
  }

  private summary(c: MockCharacter): CharacterSummary {
    const { character } = buildSnapshot(c, this.rules);
    return { id: c.id, name: c.name, build: buildName(character), level: c.levelOrder.length, ruleset: c.ruleset, portrait: c.portrait, favorite: c.favorite, group: c.group, updatedAt: c.updatedAt, path: c.path, missingContent: this.missingByChar.get(c.id)?.length ?? 0 };
  }

  /* ---------- app & characters ---------- */

  async appVersion() { return "0.1.0-mock"; }

  async listCharacters(): Promise<CharacterSummary[]> {
    await this.tick();
    return [...this.chars.values()].map((c) => this.summary(c));
  }

  async createCharacter({ request }: { request: Parameters<Api["createCharacter"]>[0]["request"] }) {
    await this.tick();
    const c = createCharacter(request, { playerName: this.settings.playerName });
    this.chars.set(c.id, c);
    return this.snap(c);
  }

  async loadCharacter({ characterId }: { characterId: string }) { await this.tick(); return this.snap(this.get(characterId)); }
  async getSnapshot({ characterId }: { characterId: string }) { await this.tick(); return this.snap(this.get(characterId)); }

  async saveCharacter({ characterId }: { characterId: string }) {
    await this.tick();
    const c = { ...this.get(characterId), dirty: false, path: this.get(characterId).path ?? `/library/${characterId}.json` };
    this.chars.set(characterId, c);
    this.saved.set(characterId, c);
    return this.snap(c);
  }

  async saveCharacterAs({ characterId, name }: { characterId: string; name?: string }) {
    await this.tick();
    const c = { ...this.get(characterId), name: name ?? this.get(characterId).name, path: name ? `/library/${characterId}.json` : `/home/me/${characterId}.json`, dirty: false };
    this.chars.set(characterId, c);
    this.saved.set(characterId, c);
    return this.snap(c);
  }

  async closeCharacter({ characterId, discard }: { characterId: string; discard: boolean }) {
    await this.tick();
    const saved = this.saved.get(characterId);
    if (!saved) { if (discard) this.chars.delete(characterId); return; }
    if (discard) this.chars.set(characterId, saved);
  }

  async deleteCharacter({ characterId }: { characterId: string }) { await this.tick(); this.chars.delete(characterId); this.saved.delete(characterId); this.missingByChar.delete(characterId); }

  async duplicateCharacter({ characterId }: { characterId: string }) {
    await this.tick();
    const src = this.get(characterId);
    const copy = { ...src, id: `${src.id}-copy-${this.chars.size}`, name: `${src.name} (copy)`, favorite: false, dirty: true, path: null };
    this.chars.set(copy.id, copy);
    return this.summary(copy);
  }

  async updateCharacterMeta(a: { characterId: string; name?: string; group?: string; favorite?: boolean }) {
    return this.mutate(a.characterId, (c) => ({ ...c, name: a.name ?? c.name, group: a.group ?? c.group, favorite: a.favorite ?? c.favorite }));
  }

  async setPortrait({ characterId, dataUrl }: { characterId: string; dataUrl: string | null }) {
    return this.mutate(characterId, (c) => ({ ...c, portrait: dataUrl }));
  }

  async importCharacter({ fileName, contentBase64 }: { fileName: string; contentBase64: string }): Promise<ImportReport> {
    await this.tick();
    let name = fileName.replace(/\.[^.]+$/, "");
    try {
      const parsed = JSON.parse(decodeURIComponent(escape(atob(contentBase64)))) as { name?: string };
      if (parsed.name) name = parsed.name;
    } catch { /* legacy binary: use the file name */ }
    const c = createCharacter({ name, ruleset: "dnd2014", startingLevel: 1, gender: "", abilityMethod: "manual", options: {} }, { playerName: this.settings.playerName });
    this.chars.set(c.id, c);
    // Files named like "*missing*" behave as characters that reference content which is not installed.
    const missing: MissingContentItem[] = /missing/i.test(fileName) && !this.contentAvailable ? [
      { id: "ID_WOTC_TCOE_ARCHETYPE_FEATURE_TWILIGHT_DOMAIN_EYES_OF_NIGHT", type: "Archetype Feature", name: "Eyes Of Night", context: "dependency", source: "WOTC TCOE" },
      { id: "ID_WOTC_TCOE_FEAT_SKILL_EXPERT", type: "Feat", name: "Skill Expert", context: "selection", source: "WOTC TCOE" },
      { id: "ID_HOMEBREW_SPELL_RADIANT_BLAST", type: "Spell", name: "Radiant Blast", context: "selection", source: "HOMEBREW" },
    ] : [];
    if (missing.length > 0) this.missingByChar.set(c.id, missing);
    return {
      summary: this.summary(c), warnings: /bad-json/i.test(fileName) ? [] : ["Mock importer: only the character name was read."],
      divergences: ["legacy.nonpositive_merge: negative AC modifiers are now counted."],
      missingContent: missing,
      unmappedSlots: missing.length > 0 ? [{ owner: missing[1]?.id ?? "", type: "Class Feature", name: "Fighting Style, Skill Expert", chosen: "ID_WOTC_PHB_CLASS_FEATURE_FIGHTINGSTYLE_ARCHERY", reason: "the owner element is not installed" }] : [],
      invalidSelections: [], selectionsImported: 12,
    };
  }

  /** Test hook: pretend the content the "missing" characters need has been installed. */
  makeMissingContentAvailable(): void { this.contentAvailable = true; }

  async recheckMissingContent(): Promise<RecheckReport> {
    await this.tick();
    const entries = [...this.missingByChar.entries()].map(([id, still]) => ({ characterId: id, name: this.get(id).name, stillMissing: still }));
    if (this.contentAvailable) {
      const updated = entries.map((e) => ({ characterId: e.characterId, name: e.name, resolved: e.stillMissing.length, stillMissing: [], stillUnmapped: [] }));
      this.missingByChar.clear();
      return { checked: updated.length, updated, outstanding: [] };
    }
    const outstanding = entries.map((e) => ({ ...e, resolved: 0, stillUnmapped: [] }));
    return { checked: outstanding.length, updated: [], outstanding };
  }

  async exportCharacter({ characterId }: { characterId: string }): Promise<ExportResult> {
    await this.tick();
    const c = this.get(characterId);
    return { fileName: `${c.name}.json`, mime: "application/json", path: null, dataBase64: b64(JSON.stringify({ format_version: 1, name: c.name, ruleset: c.ruleset })) };
  }

  /* ---------- selections ---------- */

  async getSlotOptions(a: SlotOptionsArgs): Promise<Page<SlotOption>> {
    await this.tick();
    const c = this.snapshotChar(a.characterId);
    const def = findByWireId(buildSlotDefs(c), a.slotId);
    if (!def) throw apiError("not_found", `Unknown slot ${a.slotId}`);
    const { snapshot } = buildSnapshot(c, this.rules);
    const offered = def.candidates
      .filter((e) => {
        if (e.type !== "multiclass") return true;
        const cls = getClass(e.id.slice(6));
        return !!cls && cls.multiclassAbility.some((k) => snapshot.abilities.final[k] >= 13);
      })
      .map((e) => toVersion(e, c.ruleset));
    // B-55: one row per name; `total` counts rows and paging applies to rows.
    const rows = queryRows(groupRows(offered, c.ruleset, c.choices[def.id] ?? null), a.query);
    const offset = a.offset ?? 0;
    return { total: rows.length, items: rows.slice(offset, offset + (a.limit ?? DEFAULT_PAGE)) };
  }

  /** B-55 sec. 3: switch the slot's pick to another version of its row, keeping the sub-choices that still fit. */
  async switchVersion({ characterId, slotId, elementId }: { characterId: string; slotId: string; elementId: string }): Promise<SwitchVersionResult> {
    let dropped: string[] = [];
    const snapshot = await this.mutate(characterId, (c) => {
      const r = switchVersionChoices(c, slotId, elementId);
      dropped = r.dropped;
      return { ...c, choices: r.choices };
    });
    return { snapshot, dropped };
  }

  private snapshotChar(id: string): MockCharacter { return this.get(id); }

  async applySelection({ characterId, slotId, elementId }: { characterId: string; slotId: string; elementId: string }) {
    return this.mutate(characterId, (c) => {
      const def = findByWireId(buildSlotDefs(c), slotId);
      if (!def) throw apiError("not_found", `Unknown slot ${slotId}`);
      if (def.locked) throw apiError("invalid_argument", "This selection is locked.");
      if (!def.candidates.some((e) => e.id === elementId)) throw apiError("requirement_failed", "That option is not available for this slot.");
      return { ...c, choices: { ...c.choices, [def.id]: elementId } };
    });
  }

  async clearSelection({ characterId, slotId }: { characterId: string; slotId: string }) {
    return this.mutate(characterId, (c) => {
      const key = findByWireId(buildSlotDefs(c), slotId)?.id;
      if (!key) throw apiError("not_found", `Unknown slot ${slotId}`);
      const { [key]: _cleared, ...choices } = c.choices;
      return { ...c, choices };
    });
  }

  async replaceSpell({ characterId, slotId }: { characterId: string; slotId: string }) {
    return this.mutate(characterId, (c) => {
      const def = findByWireId(buildSlotDefs(c), slotId);
      if (!def) throw apiError("not_found", `Unknown slot ${slotId}`);
      const key = def.id;
      const old = c.choices[key];
      if (def.elementType !== "spell" || !old) throw apiError("invalid_argument", "No spell is chosen in that slot.");
      if (!def.allowReplace) throw apiError("requirement_failed", `${getElement(old)?.name ?? old} cannot be replaced.`);
      const classSlot = def.classSlotId ?? "";
      const level = Math.max(levelOf(c, classSlot), def.requiredLevel ?? 1);
      const spent = buildSlotDefs(c).some((d) => d.classSlotId === def.classSlotId
        && (c.slotHistory?.[d.id] ?? []).some((p) => p.level === level && (p.id.includes("cantrip") === old.includes("cantrip"))));
      if (spent) throw apiError("requirement_failed", "Only one spell can be replaced each time a level is gained.");
      const { [key]: _old, ...choices } = c.choices;
      const prepared = Object.fromEntries(Object.entries(c.prepared).map(([k, v]) => [k, v.filter((s) => s !== old)]));
      const history = c.slotHistory ?? {};
      const slotHistory = { ...history, [key]: [...(history[key] ?? []), { id: old, level }] };
      return { ...c, choices, prepared, slotHistory };
    });
  }

  /* ---------- levels ---------- */

  async setXp({ characterId, xp }: { characterId: string; xp: number }) { return this.mutate(characterId, (c) => ({ ...c, xp: Math.max(0, Math.round(xp)) })); }
  async levelUp({ characterId, classSlotId }: { characterId: string; classSlotId: string }) { return this.mutate(characterId, (c) => lv.levelUp(c, classSlotId)); }
  async levelDown({ characterId }: { characterId: string }) { return this.mutate(characterId, lv.levelDown); }
  async addMulticlass({ characterId }: { characterId: string }) { return this.mutate(characterId, lv.addMulticlass); }
  async setHpRoll(a: { characterId: string; classSlotId: string; level: number; value: number }) { return this.mutate(a.characterId, (c) => lv.setHpRoll(c, a.classSlotId, a.level, a.value)); }

  /* ---------- abilities ---------- */

  async setAbilityMethod(a: { characterId: string; method: Parameters<typeof abil.setMethod>[1] }) { return this.mutate(a.characterId, (c) => abil.setMethod(c, a.method)); }
  async setBaseScore(a: { characterId: string; ability: Parameters<typeof abil.setBase>[1]; value: number }) { return this.mutate(a.characterId, (c) => abil.setBase(c, a.ability, a.value, this.rules)); }
  async rollAbilities(a: { characterId: string; ability?: Parameters<typeof abil.setBase>[1] }) { return this.mutate(a.characterId, (c) => abil.rollAbilities(c, this.rng, a.ability)); }
  async assignStandardArray(a: { characterId: string; ability: Parameters<typeof abil.setBase>[1]; value: number | null }) { return this.mutate(a.characterId, (c) => abil.assignArray(c, a.ability, a.value)); }
  async resetAbilities({ characterId }: { characterId: string }) { return this.mutate(characterId, (c) => abil.setMethod(c, c.method)); }

  /* ---------- options, restrictions, ruleset ---------- */

  async setCharacterOptions(a: { characterId: string; options: Partial<MockCharacter["options"]> }) {
    return this.mutate(a.characterId, (c) => ({ ...c, options: { ...c.options, ...a.options, custom: { ...c.options.custom, ...(a.options.custom ?? {}) } } }));
  }

  async previewSourceRestrictions(a: { characterId: string; enabledSources: string[] | null }): Promise<RestrictionPreview> {
    await this.tick();
    const c = this.get(a.characterId);
    // As the host: the current picks from a source the restriction switches off (they stay chosen).
    const enabled = a.enabledSources;
    const off = (id: string) => { const e = getElement(id); return !!enabled && !!e && !enabled.includes(e.source); };
    const titles = new Map(buildSlotDefs(c).map((d) => [d.id, d.title]));
    return { affected: Object.entries(c.choices).filter(([, id]) => off(id)).map(([key, id]) => ({ slotId: toWireSlotId(key), slotTitle: titles.get(key) ?? key, element: getElement(id)?.name ?? id })) };
  }

  async setSourceRestrictions(a: { characterId: string; enabledSources: string[] | null }) {
    return this.mutate(a.characterId, (c) => ({ ...c, sourceRestrictions: a.enabledSources }));
  }

  async setAllowCrossEdition(a: { characterId: string; allow: boolean | null }) {
    return this.mutate(a.characterId, (c) => ({ ...c, allowCrossEdition: a.allow }));
  }

  async getCompatibilityReport({ characterId }: { characterId: string }): Promise<CompatibilityReport> {
    await this.tick();
    const c = this.get(characterId);
    return { strict: !(c.allowCrossEdition ?? c.ruleset === "dnd2024"), entries: [] };
  }

  async getRulesetProfile({ ruleset }: { ruleset: keyof typeof PROFILES }) { await this.tick(); return PROFILES[ruleset]; }
  async listCharacterOptions(_: { ruleset: Ruleset }) { await this.tick(); return OPTION_DEFS.map((d) => ({ ...d })); }
  async classCountsByEdition() { await this.tick(); return classCounts(); }
  async startOverInEdition({ characterId, ruleset }: { characterId: string; ruleset: Ruleset }) {
    await this.tick();
    const old = this.get(characterId);
    if (ruleset === old.ruleset) throw apiError("invalid_argument", "Choose the other edition to start over in.");
    const c = startedOver(old, ruleset, this.settings.playerName);
    this.chars.set(c.id, c);
    this.saved.set(c.id, c);
    return this.snap(c);
  }

  /* ---------- magic ---------- */

  async setSpellPrepared(a: { characterId: string; classSlotId: string; spellId: string; prepared: boolean }) {
    return this.mutate(a.characterId, (c) => {
      const { snapshot } = buildSnapshot(c, this.rules);
      const cls = snapshot.spellcasting.classes.find((x) => x.classSlotId === a.classSlotId);
      if (!cls) throw apiError("not_found", "Not a spellcasting class.");
      const spell = cls.spells.find((s) => s.id === a.spellId);
      if (!spell || spell.level === 0 || spell.alwaysPrepared) throw apiError("invalid_argument", "This spell cannot be toggled.");
      if (a.prepared && !spell.prepared && cls.preparedCount >= cls.preparedMax) throw apiError("requirement_failed", `You can prepare at most ${cls.preparedMax} spells.`);
      const cur = new Set(c.prepared[a.classSlotId] ?? []);
      if (a.prepared) cur.add(a.spellId);
      else cur.delete(a.spellId);
      return { ...c, prepared: { ...c.prepared, [a.classSlotId]: [...cur] } };
    });
  }

  /* ---------- 2024 play state and conversion ---------- */

  async previewConvertTo2024({ characterId }: { characterId: string }) { await this.tick(); return play.previewConversion(this.get(characterId)); }

  async applyConvertTo2024({ characterId }: { characterId: string }) {
    await this.tick();
    const src = this.get(characterId);
    const preview = play.previewConversion(src);
    const id = `mock-${this.chars.size + 1}-${Date.now().toString(36)}`;
    const copy: MockCharacter = { ...src, id, name: preview.name, ruleset: "dnd2024", path: null, dirty: false, play: undefined, updatedAt: new Date().toISOString() };
    this.chars.set(id, copy);
    this.saved.set(id, copy);
    return { newCharacterId: id, snapshot: this.snap(copy) };
  }

  async spendResource(a: { characterId: string; resourceId: string; uses?: number }) { return this.mutate(a.characterId, (c) => play.spend(c, a.resourceId, a.uses ?? 1)); }
  async restoreResource(a: { characterId: string; resourceId: string; uses?: number }) { return this.mutate(a.characterId, (c) => play.restore(c, a.resourceId, a.uses ?? 1)); }
  async shortRest(a: { characterId: string }) { return this.mutate(a.characterId, play.shortRest); }
  async longRest(a: { characterId: string }) { return this.mutate(a.characterId, play.longRest); }
  async setToggle(a: { characterId: string; toggleId: string; on: boolean }) { return this.mutate(a.characterId, (c) => play.setToggle(c, a.toggleId, a.on)); }
  async setExhaustion(a: { characterId: string; level: number }) { return this.mutate(a.characterId, (c) => play.setExhaustion(c, a.level)); }
  async setHeroicInspiration(a: { characterId: string; has: boolean }) { return this.mutate(a.characterId, (c) => play.setInspiration(c, a.has)); }
  /** Spell tracker (GitHub #2); `sc` = the spellcasting the snapshot shows. */
  private tracked(id: string, fn: (t: track.MockTracking | undefined, sc: CharacterSnapshot["spellcasting"]) => track.MockTracking) {
    return this.mutate(id, (c) => play.withTracking(c, (t) => fn(t, buildSnapshot(c, this.rules).snapshot.spellcasting)));
  }
  async spendSpellSlot(a: Parameters<Api["spendSpellSlot"]>[0]) { return this.tracked(a.characterId, (t, sc) => track.spendSlots(t, sc, a.level, a.pact ?? false, a.uses ?? 1)); }
  async restoreSpellSlot(a: Parameters<Api["restoreSpellSlot"]>[0]) { return this.tracked(a.characterId, (t, sc) => track.restoreSlots(t, sc, a.level, a.pact ?? false, a.uses ?? 1)); }
  async setConcentration(a: Parameters<Api["setConcentration"]>[0]) { return this.tracked(a.characterId, (t, sc) => track.setConcentration(t, sc, a.spellId)); }
  async addTracker(a: Parameters<Api["addTracker"]>[0]) { return this.tracked(a.characterId, (t) => track.addTracker(t, a.name, a.max, a.reset, a.countsUp ?? false)); }
  async updateTracker(a: Parameters<Api["updateTracker"]>[0]) { return this.tracked(a.characterId, (t) => track.updateTracker(t, a.trackerId, a.name, a.max, a.reset, a.countsUp ?? false)); }
  async removeTracker(a: Parameters<Api["removeTracker"]>[0]) { return this.tracked(a.characterId, (t) => track.removeTracker(t, a.trackerId)); }
  async spendTracker(a: Parameters<Api["spendTracker"]>[0]) { return this.tracked(a.characterId, (t) => track.spendTracker(t, a.trackerId, a.uses ?? 1)); }
  async restoreTracker(a: Parameters<Api["restoreTracker"]>[0]) { return this.tracked(a.characterId, (t) => track.restoreTracker(t, a.trackerId, a.uses ?? 1)); }
  async chooseWeaponMasteries(a: { characterId: string; weaponIds: string[] }) { return this.mutate(a.characterId, (c) => play.chooseMasteries(c, a.weaponIds)); }
  async setWildShapeForms(a: { characterId: string; formIds: string[] }) { return this.mutate(a.characterId, (c) => play.setForms(c, a.formIds)); }
  async chooseEquipmentPackage(a: { characterId: string; packageId: string; option: string }) { return this.mutate(a.characterId, (c) => play.choosePackage(c, a.packageId, a.option)); }

  /* ---------- equipment ---------- */

  async searchItems(q: Parameters<Api["searchItems"]>[0]) {
    await this.tick();
    return this.content.items(q, q.characterId ? this.itemScope(q.characterId) : OPEN_SCOPE);
  }
  async listItemCategories({ characterId }: { characterId: string }) {
    await this.tick();
    const s = this.snap(this.get(characterId));
    return this.content.itemCategories(s.spellcasting.classes.map((c) => c.className), this.itemScope(characterId));
  }
  /** The item scope of a character, as the host's (B-55 W3): edition, strict mode, enabled sources. */
  private itemScope(characterId: string): ItemScope {
    const c = this.get(characterId);
    return { ruleset: c.ruleset, crossEdition: c.allowCrossEdition ?? c.ruleset === "dnd2024", enabled: c.sourceRestrictions };
  }
  /** The sample items have no generic magic weapon or armor: nothing needs a base. */
  async listBaseItems(_: { characterId: string; itemId: string }): Promise<ItemSummary[]> { await this.tick(); return []; }
  async addItem(a: { characterId: string; itemId: string; quantity: number; buy: boolean }) { return this.mutate(a.characterId, (c) => rolled.rollGained(c, eq.addItem(c, a.itemId, a.quantity, a.buy, this.content.proxyLine(a.itemId)), this.rng)); }
  async removeItem(a: { characterId: string; inventoryId: string; all: boolean }) { return this.mutate(a.characterId, (c) => eq.removeItem(c, a.inventoryId, a.all)); }
  async equipItem(a: { characterId: string; inventoryId: string; slot: Parameters<typeof eq.equipItem>[2] }) { return this.mutate(a.characterId, (c) => eq.equipItem(c, a.inventoryId, a.slot)); }
  async unequipItem(a: { characterId: string; inventoryId: string }) { return this.mutate(a.characterId, (c) => eq.unequipItem(c, a.inventoryId)); }
  async setItemRequirementsOverride(a: { characterId: string; inventoryId: string; on: boolean }) { return this.mutate(a.characterId, (c) => eq.setRequirementsOverride(c, a.inventoryId, a.on)); }
  async setRolledMax(a: { characterId: string; inventoryId: string; resourceId: string; value: number }) { return this.mutate(a.characterId, (c) => rolled.setRolledMax(c, a.inventoryId, a.resourceId, a.value)); }
  async rerollMax(a: { characterId: string; inventoryId: string; resourceId: string }) { return this.mutate(a.characterId, (c) => rolled.rerollMax(c, a.inventoryId, a.resourceId, this.rng)); }
  async setAttuned(a: { characterId: string; inventoryId: string; attuned: boolean }) { return this.mutate(a.characterId, (c) => eq.setAttuned(c, a.inventoryId, a.attuned)); }
  async storeItem(a: { characterId: string; inventoryId: string; storage: 0 | 1 | 2 }) { return this.mutate(a.characterId, (c) => eq.storeItem(c, a.inventoryId, a.storage)); }
  async moveItem(a: { characterId: string; inventoryId: string; direction: "up" | "down" }) { return this.mutate(a.characterId, (c) => eq.moveItem(c, a.inventoryId, a.direction)); }
  async extractPack(a: { characterId: string; inventoryId: string }) { return this.mutate(a.characterId, (c) => eq.extractPack(c, a.inventoryId)); }
  async adjustCoins(a: { characterId: string; coin: Parameters<typeof eq.adjustCoins>[1]; delta: number }) { return this.mutate(a.characterId, (c) => eq.adjustCoins(c, a.coin, a.delta)); }
  async convertCoins(a: { characterId: string; to: Parameters<typeof eq.convertCoins>[1] }) { return this.mutate(a.characterId, (c) => eq.convertCoins(c, a.to)); }
  async setStorageNames(a: { characterId: string; names: [string, string] }) { return this.mutate(a.characterId, (c) => ({ ...c, storageNames: a.names })); }
  async updateItemDetails(a: Parameters<Api["updateItemDetails"]>[0]) {
    return this.mutate(a.characterId, (c) => ({ ...c, items: c.items.map((i) => (i.id === a.inventoryId ? { ...i, ...a.patch } : i)) }));
  }

  /* ---------- explain ---------- */

  /** Minimal trace: one seed step carrying the derived value (the real engine lists every rule). */
  async explainStat({ characterId, stat }: { characterId: string; stat: string }): Promise<StatTrace> {
    await this.tick();
    const key = stat.trim().toLowerCase();
    if (!key) throw apiError("invalid_argument", "Name the statistic to explain.");
    const { stats, abilities } = this.snap(this.get(characterId));
    const scores: Record<string, number> = Object.fromEntries(
      (["str", "dex", "con", "int", "wis", "cha"] as const).map((k) => [`${{ str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" }[k]}:score`, abilities.final[k]]),
    );
    const known: Record<string, number> = {
      ac: stats.armorClass, initiative: stats.initiative, speed: stats.speed, hp: stats.hpMax, proficiency: stats.proficiencyBonus, ...scores,
    };
    const value = known[key] ?? 0;
    return {
      stat: key, base: value, value,
      steps: [{ group: key, kind: "seed", label: "Mock total", ruleKind: "seed", value, included: true, inputs: [] }],
      diagnostics: key in known ? [] : [{ code: "unknown_stat", severity: "info", message: `The mock backend does not know ${key}.` }],
    };
  }

  /* ---------- manage ---------- */

  async updateDetails(a: Parameters<Api["updateDetails"]>[0]) { return this.mutate(a.characterId, (c) => ({ ...c, details: { ...c.details, ...a.patch } })); }

  async upsertAttack({ characterId, attack }: Parameters<Api["upsertAttack"]>[0]) {
    return this.mutate(characterId, (c) => {
      const id = attack.id ?? `atk-${c.attacks.length + 1}-${Date.now().toString(36)}`;
      const { asCard, ...rest } = attack;
      const full: Attack = { ...rest, card: asCard ?? rest.card, id };
      const exists = c.attacks.some((x) => x.id === id);
      return { ...c, attacks: exists ? c.attacks.map((x) => (x.id === id ? full : x)) : [...c.attacks, full] };
    });
  }

  async removeAttack(a: { characterId: string; attackId: string }) { return this.mutate(a.characterId, (c) => ({ ...c, attacks: c.attacks.filter((x) => x.id !== a.attackId) })); }

  async moveAttack(a: { characterId: string; attackId: string; direction: "up" | "down" }) {
    return this.mutate(a.characterId, (c) => {
      const i = c.attacks.findIndex((x) => x.id === a.attackId);
      const j = a.direction === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= c.attacks.length) return c;
      const attacks = [...c.attacks];
      [attacks[i], attacks[j]] = [attacks[j]!, attacks[i]!];
      return { ...c, attacks };
    });
  }

  async updateCompanion(a: Parameters<Api["updateCompanion"]>[0]) {
    return this.mutate(a.characterId, (c) => ({ ...c, companionName: a.patch.name ?? c.companionName, companionPortrait: a.patch.portrait === undefined ? c.companionPortrait : a.patch.portrait }));
  }

  /* ---------- sheet ---------- */

  async renderSheet({ characterId }: { characterId: string }): Promise<SheetPreview> {
    await this.tick();
    return { html: renderSheetHtml(this.snap(this.get(characterId))), pageCount: 2, generatedAt: new Date().toISOString() };
  }

  async exportSheet({ characterId }: Parameters<Api["exportSheet"]>[0]): Promise<ExportResult> {
    await this.tick();
    const html = renderSheetHtml(this.snap(this.get(characterId)));
    return { fileName: `${this.get(characterId).name}.html`, mime: "text/html", path: null, dataBase64: b64(html) };
  }

  /* ---------- compendium & content ---------- */

  async searchCompendium({ query }: Parameters<Api["searchCompendium"]>[0]) { await this.tick(); return this.content.search(query); }
  async getElement({ elementId }: { elementId: string }) { await this.tick(); return this.content.element(elementId); }
  async compendiumFacets() { await this.tick(); return this.content.facets(); }
  async search({ request }: Parameters<Api["search"]>[0]) { await this.tick(); return mockSearch(this.content.searchDocs(), request); }
  async searchIndexStatus() { await this.tick(); return { ...MOCK_INDEX_STATUS }; }
  async getSearchPassage({ docKey }: { docKey: string }) { await this.tick(); return mockPassage(docKey); }
  async listPacks() { await this.tick(); return this.content.packs(); }
  async importPack({ request }: Parameters<Api["importPack"]>[0]) { await this.tick(); return this.content.import(request); }
  /** Files a mock "choose folder" yields (tests set this; the real backend reads the picked folder). */
  folderFiles: ImportFileInput[] = [];
  private previews = new MockImportPreview();
  /** Files the mock OS handed to the app; drained by `takeOpenedFiles`. */
  openedFiles: OpenedFile[] = [];
  async previewImportPack({ request }: Parameters<Api["previewImportPack"]>[0]) {
    await this.tick();
    const folder = request.folder ? { name: this.picks.resolve(request.folder, "content-folder").split("/").pop() ?? "content", files: this.folderFiles } : null;
    return this.previews.preview(request, folder, this.content.editions);
  }
  async installImportPreview({ previewId, editions }: { previewId: string; editions?: Record<string, BookRuleset> | null }) {
    await this.tick();
    const { preview, texts } = this.previews.take(previewId, editions);
    for (const [book, edition] of Object.entries(editions ?? {})) this.content.editions.set(book, edition);
    if (!preview.converted) throw apiError("invalid_argument", "Nothing could be imported.");
    const installed = await this.content.import({ fileName: `${preview.packName}.xml`, contentBase64: btoa(texts.join("\n")) });
    this.makeMissingContentAvailable(); // the real backend re-resolves missing content after every install
    // The install report lists every issue of the staged conversion (the preview's list, uncapped there).
    return { ...installed, report: { ...installed.report, issues: preview.diagnostics } };
  }
  async cancelImportPreview({ previewId }: { previewId: string }) { await this.tick(); this.previews.cancel(previewId); }
  async takeOpenedFiles() { await this.tick(); const out = this.openedFiles; this.openedFiles = []; return out; }
  async setPackEnabled(a: { packId: string; enabled: boolean }) { await this.tick(); return this.content.setEnabled(a.packId, a.enabled); }
  async removePack({ packId }: { packId: string }) { await this.tick(); return this.content.remove(packId); }
  async listSources() { await this.tick(); return this.content.sources(); }
  async setSourceEdition(a: { sourceId: string; edition: BookRuleset }) { await this.tick(); return this.content.setSourceEdition(a.sourceId, a.edition); }
  async listIndexes() { await this.tick(); return this.content.listIndexes(); }
  async addIndex({ url }: { url: string }) { await this.tick(); return this.content.addIndex(url); }
  async removeIndex({ url }: { url: string }) { await this.tick(); return this.content.removeIndex(url); }
  async updateIndexes() { await this.tick(); return this.content.update(); }
  async scan5etoolsFolder({ folder }: { folder: string }) { await this.tick(); return this.content.scan5etools(this.picks.resolve(folder, "5etools-folder")); }
  async stage5etoolsZip({ file }: Parameters<Api["stage5etoolsZip"]>[0]) { await this.tick(); return this.picks.stageZip(file); }
  async import5etools({ request }: Parameters<Api["import5etools"]>[0]) {
    await this.tick();
    const report = this.content.import5etools(this.picks.resolve(request.folder, "5etools-folder"), request);
    this.fivetoolsUrls.remember(request.folder, request.sources, report);
    return report;
  }
  async stage5etoolsUrl({ url }: Parameters<Api["stage5etoolsUrl"]>[0]) {
    await this.tick();
    const address = this.fivetoolsUrls.check(url);
    this.emit("import5etools:progress", { phase: "downloading", done: 1, total: 1, message: "books.json" });
    const pick = this.picks.stageUrl(address);
    this.fivetoolsUrls.stage(pick.token, address);
    return pick;
  }
  async list5etoolsUrls() { await this.tick(); return this.fivetoolsUrls.list(); }
  async remove5etoolsUrl({ url }: Parameters<Api["remove5etoolsUrl"]>[0]) { await this.tick(); return this.fivetoolsUrls.remove(url); }
  async update5etoolsUrl({ url }: Parameters<Api["update5etoolsUrl"]>[0]) {
    await this.tick();
    return this.fivetoolsUrls.update(url, (sources) => {
      const pick = this.picks.stageUrl(url);
      return this.content.import5etools(this.picks.resolve(pick.token, "5etools-folder"), { folder: pick.token, sources, includeFluff: false });
    });
  }
  async clearDownloadedContent() { await this.tick(); return this.content.clearDownloaded(); }

  /** Test/e2e hook: set stored settings synchronously, before the UI mounts (e.g. to skip the content-import notice). */
  presetSettings(patch: Partial<AppSettings>): void { this.settings = { ...this.settings, ...patch }; }

  /* ---------- settings ---------- */

  async getSettings() { await this.tick(); return this.settings; }
  async saveSettings({ patch }: { patch: Partial<AppSettings> }) {
    await this.tick();
    const override = patch.ai?.overridePath;
    if (override !== undefined && override !== null && override !== this.settings.ai.overridePath) {
      throw apiError("invalid_argument", "Choose the AI program with the Choose button; it cannot be set directly.");
    }
    for (const key of ["documentsDir", "secondaryContentDir"] as const) {
      if (patch[key] !== undefined && patch[key] !== this.settings[key]) {
        throw apiError("invalid_argument", "Choose folders with the folder button; they cannot be set directly.");
      }
    }
    this.settings = { ...this.settings, ...patch, sheet: { ...this.settings.sheet, ...(patch.sheet ?? {}), cardsNewPage: { ...this.settings.sheet.cardsNewPage, ...(patch.sheet?.cardsNewPage ?? {}) } }, ai: { ...this.settings.ai, ...(patch.ai ?? {}) }, mobile: this.mobile };
    if (this.mobile) this.settings = { ...this.settings, ai: { ...this.settings.ai, enabled: false } };
    return this.settings;
  }

  async pickPath({ purpose, startDir }: { purpose: PickPurpose; startDir?: string }) { await this.tick(); return this.picks.pick(purpose, startDir); }
  async takePickedFiles({ purpose, tokens }: { purpose: PickPurpose; tokens: string[] }) { await this.tick(); return this.picks.read(purpose, tokens); }
  /** Simulates files dropped on the window from the OS (the backend's native drag-drop handler). */
  dropFiles(files: { name: string; contentBase64: string }[]): void { this.emit("files:dropped", this.picks.drop(files)); }
  dropFolder(name: string): void { this.emit("files:dropped", this.picks.dropFolder(name)); }
  async setAiOverride({ token }: { token: string }) {
    await this.tick();
    const path = this.picks.take(token, "ai-override");
    if (!/(^|\/)(claude|codex)(\.exe|\.cmd)?$/.test(path)) throw apiError("invalid_argument", "That program cannot be used for AI: only the claude or codex command line programs are allowed.");
    this.settings = { ...this.settings, ai: { ...this.settings.ai, overridePath: path } };
    return this.settings;
  }
  async getDataDirs() { await this.tick(); return this.dataFiles.dirs(this.settings); }
  async setDocumentsDir({ token }: { token?: string }) {
    await this.tick();
    this.settings = this.dataFiles.setDocuments(this.settings, token);
    return this.dataFiles.dirs(this.settings);
  }
  async setSecondaryContentDir({ token }: { token: string }) {
    await this.tick();
    const { settings, result } = this.dataFiles.setSecondary(this.settings, token);
    this.settings = settings;
    return result;
  }
  async unlinkSecondaryContentDir() {
    await this.tick();
    const { settings, result } = this.dataFiles.unlink(this.settings);
    this.settings = settings;
    return result;
  }
  async restoreDefaultSettings() { await this.tick(); this.settings = this.dataFiles.restore(this.settings); return this.settings; }
  async clearCaches() { await this.tick(); return this.dataFiles.clearCaches(); }
  /* Semantic model: `semantic.starts` counts consented downloads (the mock's network requests). */
  readonly semantic: MockSemantic;
  private setSemantic(on: boolean) { this.settings = { ...this.settings, search: { ...this.settings.search, semantic: on } }; }
  async semanticStatus() { await this.tick(); return this.semantic.status(this.settings.search); }
  async semanticDownloadStart() { await this.tick(); this.semantic.start(this.settings.search); this.setSemantic(true); return this.semantic.status(this.settings.search); }
  async semanticDownloadPause() { await this.tick(); this.semantic.pause(); return this.semantic.status(this.settings.search); }
  async semanticDownloadCancel() { await this.tick(); this.semantic.cancel(); this.setSemantic(false); return this.semantic.status(this.settings.search); }
  async semanticDeleteModel() { await this.tick(); this.semantic.delete(); this.setSemantic(false); return this.semantic.status(this.settings.search); }
  async semanticModelLicense() { await this.tick(); return this.semantic.license(); }
  async contentUpdateStatus() { await this.tick(); return { ...this.dataFiles.status }; }
  async appUpdateStatus() { await this.tick(); return { ...this.appUpdate.status }; }
  async checkAppUpdate() { await this.tick(); this.appUpdate.requests += 1; this.emit("appupdate:status", { ...this.appUpdate.status }); return { ...this.appUpdate.status }; }
  async openDownloadPage() { await this.tick(); this.appUpdate.opened += 1; }
  /** Web pages "opened" in the system browser (U15); exposed on `window.__mockOpenedLinks` for the web e2e. */
  readonly openedLinks: string[] = [];
  async openLink(args: { url: string }) { await this.tick(); recordOpenedLink(this.openedLinks, args.url); }
  /** Folders asked to be opened, and the log text the mock "device" holds (tests set it). */
  readonly openedFolders: string[] = [];
  recentLogs = "2026-10-15T09:00:00Z  INFO borealis_lib::app_logs: Borealis started version=\"1.0.1\"";
  async openAppFolder(args: { folder: string }) { await this.tick(); this.openedFolders.push(args.folder); }
  async getRecentLogs() { await this.tick(); return this.recentLogs; }
  /** Native log shares asked for; `nativeShare` says whether this mock "device" has one (Android). */
  nativeShare = false;
  shares = 0;
  async shareLogs() {
    await this.tick();
    if (!this.nativeShare) throw apiError("invalid_argument", "Sharing is not available on this device.");
    this.shares += 1;
  }
  async restartApp() { await this.tick(); }
  /** The browser has no haptics plugin. */
  async hapticsEnabled(): Promise<boolean> { await this.tick(); return false; }
  /** Debug-build Rust command only: the mock has no content digest. */
  async acceptanceDigest(): Promise<Record<string, unknown>> { await this.tick(); throw apiError("not_found", "The acceptance digest exists only in debug builds of the app."); }

  /* ---------- AI ---------- */

  async aiStatus() { await this.tick(); return this.ai.status(); }
  async aiStartTask({ request }: Parameters<Api["aiStartTask"]>[0]) { await this.tick(); return { taskId: this.ai.start(request) }; }
  async aiCancelTask({ taskId }: { taskId: string }) { this.ai.cancel(taskId); }
  /* ---------- Device transfer ---------- */

  readonly link: MockDeviceLink;
  /** Bundles as files; tests read `bundles.exported` / `bundles.shared` and queue OS opens with `bundles.queueOpened`. */
  readonly bundles: MockBundles;
  /** New characters that arrived by transfer or bundle land in the mock library. */
  private addReceived(names: string[]): void {
    for (const name of names) {
      const c = createCharacter({ name, ruleset: "dnd2024", startingLevel: 1, gender: "Female", abilityMethod: "manual", options: {} }, { playerName: this.settings.playerName });
      const saved = { ...c, dirty: false };
      this.chars.set(saved.id, saved);
      this.saved.set(saved.id, saved);
    }
  }
  private characterNames(selection: LinkSelection): string[] {
    return selection.characterIds.map((id) => this.chars.get(id)?.name ?? "Character");
  }
  async bundleExport({ selection }: { selection: LinkSelection }) { await this.tick(); return this.bundles.export(selection, this.characterNames(selection)); }
  async bundleShare({ selection }: { selection: LinkSelection }) { await this.tick(); return this.bundles.share(selection, this.characterNames(selection)); }
  async bundleOpen({ token }: { token: string }) { await this.tick(); return this.bundles.openFile(token); }
  async bundleAccept({ bundleId }: { bundleId: string }) { await this.tick(); return this.bundles.accept(bundleId); }
  async bundleDiscard({ bundleId }: { bundleId: string }) { await this.tick(); this.bundles.discard(bundleId); }
  async takeOpenedBundles() { await this.tick(); return this.bundles.takeOpened(); }
  async linkStartSend({ selection }: { selection: LinkSelection }) { await this.tick(); return this.link.startSend(selection); }
  async linkStartReceive() { await this.tick(); return this.link.startReceive(); }
  async linkConnect({ target, selection }: { target: string; host?: string; selection?: LinkSelection }) { await this.tick(); return this.link.connect(target, selection); }
  async linkStatus({ sessionId }: { sessionId: string }) { await this.tick(); return this.link.status(sessionId); }
  async linkAccept({ sessionId }: { sessionId: string }) { await this.tick(); return this.link.decide(sessionId, true); }
  async linkDecline({ sessionId }: { sessionId: string }) { await this.tick(); return this.link.decide(sessionId, false); }
  async linkCancel({ sessionId }: { sessionId: string }) { await this.tick(); return this.link.cancel(sessionId); }
  async linkDevices() { await this.tick(); return this.link.listDevices(); }
  async linkForgetDevice({ deviceId }: { deviceId: string }) { await this.tick(); return this.link.forgetDevice(deviceId); }

  private host: AiHostStatus = { enabled: false, supported: true, address: null, pairingCode: null, pairingExpiresInSecs: null, pairingUri: null, fingerprint: null, devices: [] };
  private requireConsent(allowed: boolean | undefined) {
    if (this.codexOnly && !allowed) throw apiError("consent_required", "This content comes from outside Borealis, and codex can run commands that read files on this computer if the content tells it to.");
  }
  private pairing(code: string) {
    return { pairingCode: code, pairingExpiresInSecs: 300, pairingUri: `borealis-pair:v2?a=192.168.1.20:4317&c=${code}&f=ab12cd34ef56`, fingerprint: "ab12 cd34 ef56 7890" };
  }
  async aiHostEnable(args?: { allowUntrustedWithCodex?: boolean }) { await this.tick(); this.requireConsent(args?.allowUntrustedWithCodex); this.host = { ...this.host, enabled: true, address: "192.168.1.20:4317", ...this.pairing("12345678") }; return this.host; }
  async aiHostDisable() { await this.tick(); this.host = { ...this.host, enabled: false, address: null, pairingCode: null, pairingExpiresInSecs: null, pairingUri: null, fingerprint: null }; return this.host; }
  async aiHostStatus() { await this.tick(); return this.host; }
  async aiHostBeginPairing() { await this.tick(); this.host = { ...this.host, ...this.pairing("87654321") }; return this.host; }
  async aiHostRevoke({ deviceId }: { deviceId: string }) { await this.tick(); this.host = { ...this.host, devices: this.host.devices.filter((d) => d.id !== deviceId) }; return this.host; }
  async aiSetupStatus() { await this.tick(); return this.setup.status(); }
  async aiSetupConfirmInstall({ provider }: { provider: AiSetupProviderId }) { await this.tick(); return this.setup.confirm(provider); }
  async aiSetupInstall({ provider, consentToken }: { provider: AiSetupProviderId; consentToken: string }) { await this.tick(); return this.setup.install(provider, consentToken); }
  async aiSetupLogin({ provider }: { provider: AiSetupProviderId; openTerminal?: boolean }) { await this.tick(); return this.setup.login(provider); }
  async aiSetupComplete(_: { skipped?: boolean }) { await this.tick(); this.setup.complete(); }
  async aiValidateHomebrew({ json }: { json: Record<string, unknown> }) { await this.tick(); return validateHomebrew(json); }
  async aiAddHomebrewToPack({ json }: { json: Record<string, unknown>; packId?: string }) {
    await this.tick();
    const report = validateHomebrew(json);
    if (!report.valid) throw apiError("content_error", report.errors.join(" "));
    return this.content.addHomebrew(json);
  }

  /* Import anything */
  async importStart(req: Parameters<Api["importStart"]>[0]) {
    await this.tick();
    this.requireConsent(req.allowUntrustedWithCodex);
    const started = await this.imp.start(req);
    if (req.allowUntrustedWithCodex) this.consented.add(started.draftId);
    return started;
  }
  async importGetDraft({ draftId }: { draftId: string }) { await this.tick(); return this.imp.get(draftId); }
  async importChooseParent({ draftId, classId, allowUntrustedWithCodex }: { draftId: string; classId: string; allowUntrustedWithCodex?: boolean }) {
    await this.tick(); this.requireConsent(allowUntrustedWithCodex || this.consented.has(draftId));
    if (allowUntrustedWithCodex) this.consented.add(draftId);
    return this.imp.chooseParent(draftId, classId);
  }
  async importRevise({ draftId, instruction, elementId, allowUntrustedWithCodex }: { draftId: string; instruction: string; elementId?: string; allowUntrustedWithCodex?: boolean }) {
    await this.tick(); this.requireConsent(allowUntrustedWithCodex || this.consented.has(draftId));
    if (allowUntrustedWithCodex) this.consented.add(draftId);
    return this.imp.revise(draftId, instruction, elementId);
  }
  async importUpdateElement({ draftId, elementId, json }: { draftId: string; elementId: string; json: Record<string, unknown> }) { await this.tick(); return this.imp.updateElement(draftId, elementId, json); }
  async importAcceptElement({ draftId, elementId, accepted }: { draftId: string; elementId: string; accepted: boolean }) { await this.tick(); return this.imp.acceptElement(draftId, elementId, accepted); }
  async importSetTextOnly({ draftId, elementId, textOnly }: { draftId: string; elementId: string; textOnly: boolean | null }) { await this.tick(); return this.imp.setTextOnly(draftId, elementId, textOnly); }
  async importRelocateElement({ draftId, elementId, startLine, endLine, allowUntrustedWithCodex }: { draftId: string; elementId: string; startLine: number; endLine: number; allowUntrustedWithCodex?: boolean }) {
    await this.tick(); this.requireConsent(allowUntrustedWithCodex || this.consented.has(draftId));
    if (allowUntrustedWithCodex) this.consented.add(draftId);
    return this.imp.relocate(draftId, elementId, startLine, endLine);
  }
  async importRegenerateElement({ draftId, elementId, allowUntrustedWithCodex }: { draftId: string; elementId: string; allowUntrustedWithCodex?: boolean }) {
    await this.tick(); this.requireConsent(allowUntrustedWithCodex || this.consented.has(draftId));
    if (allowUntrustedWithCodex) this.consented.add(draftId);
    return this.imp.regenerate(draftId, elementId);
  }
  async importFinalize({ draftId, packName, prefix }: { draftId: string; packName: string; prefix: string }) {
    await this.tick();
    const r = this.imp.finalize(draftId, packName, prefix);
    return this.content.addImportedPack(r.name, r.count);
  }
  async importDiscard({ draftId }: { draftId: string }) { await this.tick(); this.imp.discard(draftId); }
  async importReportPreview(req: Parameters<Api["importReportPreview"]>[0]) { await this.tick(); return this.reports.preview(req, (id) => this.imp.get(id)); }
  async importReportSend({ previewId }: { previewId: string }) { await this.tick(); return this.reports.send(previewId); }
}
