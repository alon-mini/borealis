/** Core vocabulary shared by every part of the backend contract. */

export type Ruleset = "dnd2014" | "dnd2024";
/** A book's rules edition (IM14): 2014, 2024, or (IM17) `any`, Both editions: offered to 2014 and 2024 characters. */
export type BookRuleset = Ruleset | "any";

export const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type AbilityKey = (typeof ABILITY_KEYS)[number];
export type AbilityRecord<T> = Record<AbilityKey, T>;

/** Content element type ids (subset the UI needs to label and filter). */
export type ElementType =
  | "race"
  | "subrace"
  | "racial-trait"
  | "class"
  | "multiclass"
  | "archetype"
  | "class-feature"
  | "fighting-style"
  | "background"
  | "background-feature"
  | "list"
  | "feat"
  | "asi"
  | "language"
  | "skill"
  | "tool"
  | "proficiency"
  | "spell"
  | "item"
  | "weapon"
  | "armor"
  | "magic-item"
  | "companion"
  | "monster"
  | "deity"
  | "option"
  | "source";

export interface ElementRef {
  id: string;
  name: string;
  type: ElementType;
  source: string;
}

/** Lightweight element row used in pickers, search results and catalogues. */
/** Casting facts of a spell (V/S/M components, casting time, range, duration). */
export interface SpellFacts {
  /** e.g. "1 action". */
  castingTime: string;
  range: string;
  duration: string;
  verbal: boolean;
  somatic: boolean;
  material: boolean;
  /** The material text; "" when there is none. */
  materialText: string;
  concentration: boolean;
  ritual: boolean;
}

/** Armor columns of a catalogue row. */
export interface ArmorFacts {
  group: "Light" | "Medium" | "Heavy" | "Shield" | string;
  /** AC as printed, e.g. "14 + Dex (max 2)" or "+2". */
  acText: string;
  /** The flat number in the AC text (the bonus for a shield). */
  acBase: number;
  addsDex: boolean;
  /** Largest Dexterity modifier that counts; null = no cap. */
  dexCap: number | null;
  /** Strength score needed to avoid the speed penalty. */
  strength: number | null;
  stealthDisadvantage: boolean;
}

/** Weapon columns of a catalogue row. */
export interface WeaponFacts {
  /** Dice only, e.g. "1d8". */
  damage: string;
  damageType: string;
  /** e.g. ["Finesse", "Versatile (1d10)"]. */
  properties: string[];
  /** Weapon Mastery property (2024 content). */
  mastery: string | null;
  /** Normal/long range in feet, e.g. "80/320". */
  range: string | null;
  /** "Simple" or "Martial". */
  proficiency: string;
  /** "Melee" or "Ranged". */
  kind: string;
}

export interface ElementSummary extends ElementRef {
  sourceName: string;
  /** One-line description (or prerequisite text when the element has any). */
  shortDescription: string;
  prerequisites: string | null;
  rulesets: Ruleset[];
  /** Spell level 0-9 when type === "spell". */
  level?: number;
  school?: string;
  tags?: string[];
  /** Casting facts (spells only). */
  spell?: SpellFacts;
  /** Armor columns (armor and shields only). */
  armor?: ArmorFacts;
  /** Weapon columns (weapons only). */
  weapon?: WeaponFacts;
}

export interface ElementFact {
  label: string;
  value: string;
}

/** Full element for the description pane / compendium detail. */
export interface ElementDetail extends ElementSummary {
  /** Already sanitised by the backend (allow-list); the UI sanitises again defensively. */
  descriptionHtml: string;
  facts: ElementFact[];
  /** Human-readable list of what choosing this element grants. */
  grants: string[];
}

export interface Page<T> {
  total: number;
  items: T[];
}

/** Error shape thrown (as a rejected promise value) by every command. */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export type ApiErrorCode =
  | "not_found"
  | "invalid_argument"
  | "budget_exceeded"
  | "requirement_failed"
  | "ai_unavailable"
  | "consent_required"
  | "content_error"
  | "io_error"
  | "internal";

export function isApiError(e: unknown): e is ApiError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

export type Unsubscribe = () => void;
