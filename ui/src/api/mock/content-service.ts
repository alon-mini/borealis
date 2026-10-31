import type {
  BookRuleset, CompendiumFacets, FiveToolsImportReport, FiveToolsImportRequest, FiveToolsScan, CompendiumQuery, ContentIndex, ContentPack, ContentProgress, ContentSource, ElementDetail, ElementSummary,
  ImportPackRequest, ImportPackResult, ItemCategory, ItemQuery, ItemSummary, MigrationIssue, MigrationReport, Page, Ruleset, UpdateIndexesResult,
} from "../types";
import { issue, scanElements, xmlIssues } from "./import-issues";
import { CLASSES, ELEMENTS, ITEMS, getElement } from "./content";
import { isProxyId, itemCategoryList, matchesItemSearch, proxyRows, type ProxyRow } from "./item-categories";
import type { MockElement } from "./data-types";
import { apiError } from "./errors";
import { MockBookEditions, checkSettable } from "./book-editions";
import { BUNDLED_SOURCES, SOURCE_2014, SOURCE_2024, SOURCE_EXPANSION } from "./content";
import { groupKey } from "../../lib/versions";
import type { MockSearchDoc } from "./search";

const PROXY_PREFIX = "proxy:";
const PROXY_HINT = "Equip this item to gain what it grants. It stays off the inventory on the character sheet.";

const TYPE_LABELS: Record<string, string> = {
  race: "Races", subrace: "Subraces", class: "Classes", multiclass: "Multiclass", archetype: "Subclasses", "fighting-style": "Fighting styles",
  background: "Backgrounds", feat: "Feats", spell: "Spells", weapon: "Weapons", armor: "Armor", item: "Gear", "magic-item": "Magic items",
  skill: "Skills", language: "Languages", asi: "Ability improvements", list: "Characteristics", monster: "Monster",
};

const stripHtml = (s: string): string => s.replace(/<[^>]+>/g, "");

/**
 * The conversion report of one index the mock update downloaded (the real one is per converted pack, named by the index
 * URL): its files converted, one located warning so the report has something to show.
 */
const indexReport = (i: ContentIndex): MigrationReport => ({
  fileName: i.url, format: "xml", converted: i.updatesAvailable, skipped: 0,
  issues: [issue("warning", "dangling_reference", "grants ID_MOCK_MISSING_FEAT, which no installed content defines", {
    element: `ID_MOCK_${i.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_FEAT`, elementType: "Feat", file: `${i.name}/feats.xml`, line: 12,
  })],
});

/** Compendium, packs, sources and content indexes for the mock backend. */
export class ContentService {
  private extra: MockElement[] = [];
  private imported: ContentPack[] = [];
  private disabled = new Set<string>();
  private indexes: ContentIndex[] = [];

  constructor(private emit: (p: ContentProgress) => void, private reloaded: () => void, private emitImport: (p: ContentProgress) => void = () => undefined) {}

  private all(): MockElement[] {
    return [...ELEMENTS, ...this.extra].filter((e) => !this.disabled.has(this.packOf(e.source)));
  }

  private packOf(source: string): string {
    if (source === SOURCE_EXPANSION) return "pack-sample-expansion";
    return source === SOURCE_2014 ? "pack-srd-51" : source === SOURCE_2024 ? "pack-srd-52" : this.imported.find((p) => p.sourceIds.includes(source))?.id ?? "pack-homebrew";
  }

  private summary(e: MockElement): ElementSummary {
    const { description: _d, facts: _f, grants: _g, ...rest } = e;
    return rest;
  }

  search(q: CompendiumQuery): Page<ElementSummary> {
    const text = q.query.trim().toLowerCase();
    const hits = this.all().filter((e) => {
      if (q.types?.length && !q.types.includes(e.type)) return false;
      if (q.sources?.length && !q.sources.includes(e.source)) return false;
      if (q.ruleset && q.ruleset !== "any" && !e.rulesets.includes(q.ruleset)) return false;
      if (!text) return !["multiclass", "asi", "list"].includes(e.type);
      return e.name.toLowerCase().includes(text) || e.shortDescription.toLowerCase().includes(text) || (e.tags ?? []).some((t) => t.toLowerCase().includes(text));
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { total: hits.length, items: hits.slice(q.offset, q.offset + q.limit).map((e) => this.summary(e)) };
  }

  /** What the mock `search` ranks over (the Lore corpus). */
  searchDocs(): MockSearchDoc[] {
    return this.all().map((e) => ({ id: e.id, name: e.name, type: e.type, source: e.source, sourceName: e.sourceName, rulesets: e.rulesets, text: [...new Set([e.shortDescription, stripHtml(e.description)])].join(" ").trim() }));
  }

  element(id: string): ElementDetail {
    const target = this.proxyTarget(id);
    const proxy = target && this.proxies().find((p) => p.id === id);
    if (target && proxy) return { ...this.proxySummary(proxy), descriptionHtml: `<p>${PROXY_HINT}</p>${target.description}`, facts: [], grants: [target.name] };
    const e = this.all().find((x) => x.id === id) ?? getElement(id);
    // Like the real backend: list-rule entries (personality traits, ...) are text choices, not elements.
    if (!e || e.type === "list") throw apiError("not_found", "That element does not exist.");
    return { ...this.summary(e), descriptionHtml: e.description, facts: e.facts, grants: e.grants };
  }

  facets(): CompendiumFacets {
    const count = (key: (e: MockElement) => string) => {
      const m = new Map<string, number>();
      for (const e of this.all()) m.set(key(e), (m.get(key(e)) ?? 0) + 1);
      return m;
    };
    const types = [...count((e) => e.type)].filter(([id]) => TYPE_LABELS[id]).map(([id, n]) => ({ id, label: TYPE_LABELS[id]!, count: n }));
    const sources = [...count((e) => e.source)].map(([id, n]) => ({ id, label: this.all().find((e) => e.source === id)!.sourceName, count: n }));
    return { types, sources };
  }

  /**
   * `search_items`: inside a category the classic builder's filter (words in the name or a keyword, `+`
   * alternatives) over its items and generated proxies; without one a name search over the items only.
   */
  items(q: ItemQuery, scope: ItemScope = OPEN_SCOPE): Page<ItemSummary> {
    const text = (q.query ?? "").toLowerCase();
    const named = (name: string, keywords: string[]) => (q.category ? matchesItemSearch(name, keywords, q.query ?? "") : !text || name.toLowerCase().includes(text));
    const sourceOk = (source: string) => (!q.source || q.source === source) && sourceAllowed(scope, source);
    const hits = ITEMS.map((i) => ({ i, e: getElement(i.id)! }))
      .filter(({ i, e }) => (!q.category || i.category === q.category) && itemAdmitted(scope, e) && sourceOk(e.source) && named(e.name, []))
      .map(({ i, e }) => ({ ...this.summary(e), category: i.category, costCp: i.costCp, weight: i.weight, requiresAttunement: !!i.attune, ...(BUNDLED_SOURCES.includes(e.source) ? { bundled: true } : {}) }));
    const proxies = q.category ? this.proxies().filter((p) => p.category === q.category && sourceOk(p.source) && named(p.name, p.keywords)).map((p) => this.proxySummary(p)) : [];
    const sorted = [...hits, ...proxies].sort((a, b) => a.name.localeCompare(b.name));
    return { total: sorted.length, items: sorted.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 100)) };
  }

  /** `list_item_categories` over the sample items and proxies (`enabled` = enabled source ids, null = all). */
  itemCategories(casters: string[], scope: ItemScope): ItemCategory[] {
    const content = ITEMS.map((i) => getElement(i.id)!).map((e) => ({ category: ITEMS.find((i) => i.id === e.id)!.category, visible: itemAdmitted(scope, e) && sourceAllowed(scope, e.source), key: groupKey(e) }));
    const generated = this.proxies().map((p) => ({ category: p.category, visible: sourceAllowed(scope, p.source), key: groupKey({ type: "item", name: p.name }) }));
    return itemCategoryList([...content, ...generated], casters);
  }

  /** The generated proxy item with this id, when the listing offers it. */
  proxyLine(id: string): { id: string; name: string; category: string } | undefined {
    const p = isProxyId(id) ? this.proxies().find((x) => x.id === id) : undefined;
    return p && { id: p.id, name: p.name, category: p.category };
  }

  /** The generated proxy items of the loaded content (every caster class gets its "Additional <Class> Spell"). */
  private proxies(): ProxyRow[] {
    return proxyRows(this.all(), CLASSES.filter((c) => c.caster).map((c) => c.id));
  }

  private proxyTarget(id: string): MockElement | undefined {
    return isProxyId(id) ? this.all().find((e) => e.id === id.slice(id.indexOf(":", PROXY_PREFIX.length) + 1)) : undefined;
  }

  private proxySummary(p: ProxyRow): ItemSummary {
    const target = this.proxyTarget(p.id)!;
    return { ...this.summary(target), id: p.id, name: p.name, type: "item", shortDescription: PROXY_HINT, category: p.category, costCp: 0, weight: 0, requiresAttunement: false };
  }

  packs(): ContentPack[] {
    const n = (s: string) => ELEMENTS.filter((e) => e.source === s).length;
    const base: ContentPack[] = [
      { id: "pack-srd-51", name: "Sample Reference 5.1", version: "1.0.0", kind: "bundled", rulesets: ["dnd2014"], elementCount: n(SOURCE_2014), enabled: !this.disabled.has("pack-srd-51"), license: "CC-BY-4.0", attribution: "Sample content written for Borealis.", sourceIds: [SOURCE_2014] },
      { id: "pack-srd-52", name: "Sample Reference 5.2", version: "1.0.0", kind: "bundled", rulesets: ["dnd2024"], elementCount: n(SOURCE_2024), enabled: !this.disabled.has("pack-srd-52"), license: "CC-BY-4.0", attribution: "Sample content written for Borealis.", sourceIds: [SOURCE_2024] },
      // B-55: an imported pack whose species shares a name with the bundled ones (one picker row, three versions).
      { id: "pack-sample-expansion", name: "Sample Expansion", version: "1.0.0", kind: "imported", rulesets: ["dnd2024"], elementCount: n(SOURCE_EXPANSION), enabled: !this.disabled.has("pack-sample-expansion"), license: "CC-BY-4.0", attribution: "Sample content written for Borealis.", sourceIds: [SOURCE_EXPANSION] },
    ];
    const home = this.extra.length
      ? [{ id: "pack-homebrew", name: "My Homebrew", version: "0.1.0", kind: "homebrew" as const, rulesets: ["dnd2014", "dnd2024"] as ContentPack["rulesets"], elementCount: this.extra.length, enabled: !this.disabled.has("pack-homebrew"), license: "User", attribution: "", sourceIds: ["sample-homebrew"] }]
      : [];
    return [...base, ...home, ...this.imported.map((p) => ({ ...p, enabled: !this.disabled.has(p.id) }))];
  }

  /** IM14: the user's edition per book. */
  readonly editions = new MockBookEditions();

  sources(): ContentSource[] {
    return this.packs().flatMap((p) => p.sourceIds.map((id) => {
      const name = this.all().find((e) => e.source === id)?.sourceName ?? id;
      return {
        id, name, group: p.name, packId: p.id,
        elementCount: ELEMENTS.filter((e) => e.source === id).length + this.extra.filter((e) => e.source === id).length,
        description: `Content from ${p.name}.`, playtest: false, ...this.editions.fields(name, p),
      };
    }));
  }

  /** IM14: set an imported book's edition. */
  setSourceEdition(sourceId: string, edition: BookRuleset): ContentSource[] {
    const source = this.sources().find((s) => s.id === sourceId);
    checkSettable(source?.editionEditable, edition);
    this.editions.set(source!.name, edition);
    return this.sources();
  }

  setEnabled(packId: string, enabled: boolean): ContentPack[] {
    if (enabled) this.disabled.delete(packId);
    else this.disabled.add(packId);
    return this.packs();
  }

  remove(packId: string): ContentPack[] {
    const pack = this.packs().find((p) => p.id === packId);
    if (!pack || pack.kind === "bundled") throw apiError("invalid_argument", "Bundled packs cannot be removed.");
    this.imported = this.imported.filter((p) => p.id !== packId);
    if (packId === "pack-homebrew") this.extra = [];
    return this.packs();
  }

  import(req: ImportPackRequest): ImportPackResult {
    let text: string;
    try { text = atob(req.contentBase64); } catch { throw apiError("invalid_argument", "File content is not valid base64."); }
    const format = req.format ?? (req.fileName.toLowerCase().endsWith(".xml") ? "xml" : "json");
    const issues: MigrationIssue[] = [];
    let names: string[] = [];
    const file = req.fileName;
    if (format === "xml") {
      names = scanElements(text).map((e) => e.name);
      issues.push(...xmlIssues(text, file));
    } else {
      try {
        const doc = JSON.parse(text) as { elements?: { name?: string }[] };
        names = (doc.elements ?? []).map((e) => e.name ?? "Unnamed");
        if (!doc.elements) issues.push(issue("error", "schema_violation", 'Expected a top-level "elements" array.', { file, line: 1 }));
      } catch (e) {
        issues.push(issue("error", "xml_parse", `Invalid JSON: ${(e as Error).message}`, { file }));
      }
    }
    const report = { fileName: req.fileName, format, converted: names.length, skipped: 0, issues };
    if (!names.length) return { pack: null, report };
    const id = `pack-import-${this.imported.length + 1}`;
    const pack: ContentPack = { id, name: req.fileName.replace(/\.[^.]+$/, ""), version: "1.0.0", kind: "imported", rulesets: ["dnd2014"], elementCount: names.length, enabled: true, license: "User content", attribution: "", sourceIds: [`import-${id}`] };
    this.imported = [...this.imported, pack];
    this.reloaded();
    return { pack, report };
  }

  addImportedPack(name: string, count: number): ContentPack {
    const id = `pack-import-${this.imported.length + 1}`;
    const pack: ContentPack = { id, name, version: "1.0.0", kind: "imported", rulesets: ["dnd2024"], elementCount: count, enabled: true, license: "User content", attribution: "", sourceIds: [`import-${id}`], redistributable: false };
    this.imported = [...this.imported, pack];
    this.reloaded();
    return pack;
  }

  addHomebrew(json: Record<string, unknown>): ContentPack {
    const name = String(json.name ?? "Unnamed");
    const el: MockElement = {
      id: String(json.id ?? name), type: (json.type as MockElement["type"]) ?? "option", name, source: "sample-homebrew", sourceName: "Sample Homebrew",
      shortDescription: stripHtml(String(json.description ?? "")).slice(0, 120), prerequisites: null, rulesets: ["dnd2014", "dnd2024"],
      description: String(json.description ?? ""), facts: [], grants: [], ...(typeof json.level === "number" ? { level: json.level } : {}),
    };
    this.extra = [...this.extra.filter((e) => e.id !== el.id), el];
    this.reloaded();
    return this.packs().find((p) => p.id === "pack-homebrew")!;
  }

  listIndexes(): ContentIndex[] { return this.indexes; }

  addIndex(url: string): ContentIndex[] {
    if (!/^https?:\/\/.+\.index$/i.test(url)) throw apiError("invalid_argument", "An index URL must start with http(s) and end with .index.");
    if (/\/user\.index$/i.test(url)) throw apiError("invalid_argument", 'The name "user" is reserved for your personal content folder.');
    this.indexes = [...this.indexes.filter((i) => i.url !== url), { url, name: url.split("/").pop()!.replace(".index", ""), lastChecked: null, fileCount: 3, updatesAvailable: 3, requiresNewerApp: false, verified: false, problem: null }];
    return this.indexes;
  }

  removeIndex(url: string): ContentIndex[] {
    this.indexes = this.indexes.filter((i) => i.url !== url);
    return this.indexes;
  }

  async update(): Promise<UpdateIndexesResult> {
    const total = this.indexes.reduce((s, i) => s + i.updatesAvailable, 0);
    this.emit({ phase: "checking", done: 0, total, message: "Checking indexes" });
    for (let i = 1; i <= total; i++) this.emit({ phase: "downloading", done: i, total, message: `Downloading file ${i} of ${total}` });
    const reports = this.indexes.filter((i) => i.updatesAvailable > 0).map((i) => indexReport(i));
    this.indexes = this.indexes.map((i) => ({ ...i, updatesAvailable: 0, lastChecked: new Date().toISOString() }));
    this.emit({ phase: "reloading", done: total, total, message: "Reloading content" });
    this.reloaded();
    this.emit({ phase: "done", done: total, total, message: "Content is up to date" });
    return { updated: total, failed: [], reloaded: true, changed: [], newHosts: [], reports };
  }

  scan5etools(path: string): FiveToolsScan {
    if (!path.trim() || /missing|nonexistent/i.test(path)) throw apiError("not_found", "No 5etools data folder was found at that path.");
    return { sources: [
      { abbr: "srd", name: "SRD 5.1 (2014)", ruleset: "dnd2014", category: "book", counts: { class: 4, spell: 24, item: 12 } },
      { abbr: "srd52", name: "SRD 5.2.1 (2024)", ruleset: "dnd2024", category: "book", counts: { class: 4, spell: 30, feat: 8 } },
      { abbr: "basicRules", name: "Basic Rules (2014)", ruleset: "dnd2014", category: "book", counts: { feat: 6, spell: 10 } },
      { abbr: "QST", name: "Sample Quest", ruleset: "mixed", category: "adventure", counts: { item: 3 } },
      { abbr: "HBX", name: "My Homebrew", ruleset: "dnd2014", category: "homebrew", counts: { feat: 2 } },
    ] };
  }

  import5etools(folder: string, req: FiveToolsImportRequest): FiveToolsImportReport {
    const { sources } = this.scan5etools(folder);
    const picked = sources.filter((s) => req.sources.includes(s.abbr));
    if (!picked.length) throw apiError("invalid_argument", "Select at least one source book.");
    const total = picked.length;
    const replaced = picked.filter((src) => this.imported.some((p) => p.id === `pack-5et-${src.abbr.toLowerCase()}`)).length;
    const packs = picked.map((src, i) => {
      this.emitImport({ phase: "converting", done: i, total, message: `Converting ${src.name}` });
      const id = `pack-5et-${src.abbr.toLowerCase()}`;
      const count = Object.values(src.counts).reduce((a, b) => a + b, 0);
      const pack: ContentPack = { id, name: src.name, version: "local", kind: "local-import", rulesets: src.ruleset === "mixed" ? ["dnd2014", "dnd2024"] : [src.ruleset], elementCount: count, enabled: true,
        license: "Local import", attribution: "Converted from the user's own data folder.", sourceIds: [`5et-${src.abbr}`], redistributable: false };
      this.imported = [...this.imported.filter((p) => p.id !== id), pack];
      return pack;
    });
    this.emitImport({ phase: "done", done: total, total, message: "Import finished" });
    this.reloaded();
    const converted = packs.reduce((n, p) => n + p.elementCount, 0);
    return { converted, packs, replaced,
      partial: [
        { element: "Sample subclass", kind: "subclass", reason: "Spellcasting progression was converted with defaults." },
        { element: "Sample kit", kind: "item", reason: "pack content \"alms box\" is not an item and was not converted" },
        { element: "Sample kit", kind: "item", reason: "pack content \"censer\" is not an item and was not converted" },
      ],
      skipped: [
        { element: "Sample vehicle", kind: "vehicle", reason: "Vehicles are not supported." },
        { element: "Common|PHB", kind: "language", reason: "defined by the core pack" },
        { element: "Elvish|PHB", kind: "language", reason: "defined by the core pack" },
      ] };
  }

  clearDownloaded(): ContentPack[] {
    this.imported = this.imported.filter((p) => p.kind !== "downloaded");
    return this.packs();
  }
}


/**
 * What a character may see in the item catalogue (as the Rust host's `ItemScope`): its edition, the other edition's items
 * while strict mode is off (the mock has no superseded items), and only enabled sources (null = all).
 */
export interface ItemScope {
  ruleset: Ruleset | null;
  crossEdition: boolean;
  enabled: readonly string[] | null;
}

/** No character: every item of every source. */
export const OPEN_SCOPE: ItemScope = { ruleset: null, crossEdition: true, enabled: null };

const itemAdmitted = (scope: ItemScope, e: MockElement): boolean => !scope.ruleset || scope.crossEdition || e.rulesets.includes(scope.ruleset);
const sourceAllowed = (scope: ItemScope, source: string): boolean => !scope.enabled || scope.enabled.includes(source);
