import type { ImportFileInput, ImportPackResult, ImportPreview, PreviewDiagnostic, PreviewImportRequest, BookRuleset, UnresolvedRef } from "../types";
import { apiError } from "./errors";
import { issue, scanElements, xmlIssues } from "./import-issues";
import { type MockBookEditions, bookKey, isBookRuleset } from "./book-editions";

/** Ids the mock treats as already installed (the real backend checks the loaded content store). */
const INSTALLED = /^ID_(PHB|WOTC|INTERNAL)_/;
const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const stem = (n: string) => n.replace(/\.[^.]+$/, "");

/** The https address a lone index updates from (its info/update/file/@url). */
const sourceOf = (base64: string): string | undefined => {
  try {
    const url = /<update\b[^>]*>\s*<file\s[^>]*>/.exec(atob(base64))?.[0].match(/\burl="([^"]*)"/)?.[1]?.trim();
    return url && /^https:\/\/[^/\s]+/.test(url) ? url : undefined;
  } catch { return undefined; }
};

interface Staged { preview: ImportPreview; texts: string[] }

/** Mirrors the Rust preview: converts a set of files together, reports counts, diagnostics and unresolved references. */
export class MockImportPreview {
  private staged = new Map<string, Staged>();
  private seq = 0;

  preview(req: PreviewImportRequest, folder: { name: string; files: ImportFileInput[] } | null, editions: MockBookEditions): ImportPreview {
    const files = folder ? folder.files : (req.files ?? []);
    if (!files.length) throw apiError("invalid_argument", "Choose files or a folder to import.");
    const texts: string[] = [];
    const diagnostics: PreviewDiagnostic[] = [];
    const defined = new Set<string>();
    const counts = new Map<string, number>();
    const grants: { from: string; target: string; file: string }[] = [];
    const absent: { from: string; target: string; file: string }[] = [];
    const listed: { index: string; name: string }[] = [];
    let skipped = 0;
    const indexFiles = files.filter((f) => /\.index$/i.test(f.fileName));
    const sourceUrl = indexFiles.length === 1 ? sourceOf(indexFiles[0]!.contentBase64) : undefined;
    for (const f of files) {
      let text: string;
      try { text = atob(f.contentBase64); } catch { throw apiError("invalid_argument", "The file content is not valid base64."); }
      // The real backend names the path inside the imported set ("classes/wizard.xml").
      const file = f.fileName;
      if (/\.index$/i.test(file)) {
        for (const m of text.matchAll(/<file\s[^>]*>/g)) { const n = attr(m[0], "name"); if (n) listed.push({ index: file, name: n }); }
        continue;
      }
      const els = scanElements(text);
      diagnostics.push(...xmlIssues(text, file));
      if (!els.length) { skipped++; continue; }
      texts.push(text);
      for (const e of els) {
        defined.add(e.id); counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
        for (const g of e.body.matchAll(/<grant\s[^>]*>/g)) { const target = attr(g[0], "id"); if (target) grants.push({ from: e.id, target, file }); }
        for (const r of e.body.matchAll(/<requirements>([^<]*)<\/requirements>/g)) for (const n of r[1]!.matchAll(/!(ID_[A-Z0-9_]+)/g)) absent.push({ from: e.id, target: n[1]!, file });
      }
    }
    const present = new Set(files.map((f) => (f.fileName.split("/").pop() ?? f.fileName).toLowerCase()));
    for (const l of listed) if (!present.has(l.name.toLowerCase())) diagnostics.push(issue("info", "index_entry_missing", `index entry ${l.name} is not present locally`, { file: l.index }));
    const group = (refs: { from: string; target: string; file: string }[]): UnresolvedRef[] => {
      const byTarget = new Map<string, UnresolvedRef>();
      for (const g of refs) {
        if (defined.has(g.target) || INSTALLED.test(g.target)) continue;
        const cur = byTarget.get(g.target) ?? { target: g.target, count: 0, referencedBy: [], files: [] };
        cur.count++; if (cur.referencedBy.length < 3 && !cur.referencedBy.includes(g.from)) cur.referencedBy.push(g.from);
        if (cur.files.length < 3 && !cur.files.includes(g.file)) cur.files.push(g.file);
        byTarget.set(g.target, cur);
      }
      return [...byTarget.values()].sort((a, b) => b.count - a.count || a.target.localeCompare(b.target));
    };
    const unresolved = group(grants);
    const conditions = group(absent).filter((c) => !unresolved.some((u) => u.target === c.target));
    const first = files[0]!.fileName;
    const packName = folder ? folder.name : files.length === 1 ? stem(first) : `${stem(first)} and ${files.length - 1} more`;
    const sev = (s: string) => diagnostics.filter((d) => d.severity === s).length;
    const preview: ImportPreview = {
      previewId: `prev_mock_${++this.seq}`, packName, packId: packName.toLowerCase().replace(/[^a-z0-9]+/g, "-"), fileCount: files.length,
      converted: [...counts.values()].reduce((a, b) => a + b, 0), skipped,
      counts: [...counts].map(([type, count]) => ({ type, count })), summary: { errors: sev("error"), warnings: sev("warning"), infos: sev("info") },
      diagnostics, diagnosticsTruncated: false, unresolved, unresolvedTotal: unresolved.length, conditions, conditionsTotal: conditions.length, replacesExisting: false,
      ...(sourceUrl && !texts.length && !folder ? { indexUrl: sourceUrl } : {}),
      books: editions.previewBooks(texts),
    };
    this.staged.set(preview.previewId, { preview, texts });
    return preview;
  }

  take(previewId: string, editions?: Record<string, BookRuleset> | null): Staged {
    const s = this.staged.get(previewId);
    if (!s) throw apiError("invalid_argument", "This preview has expired. Choose the files again.");
    for (const [name, edition] of Object.entries(editions ?? {})) {
      if (!isBookRuleset(edition)) throw apiError("invalid_argument", "A book is 2014 rules, 2024 rules or Both editions.");
      if (!s.preview.books.some((b) => bookKey(b.name) === bookKey(name))) throw apiError("invalid_argument", `"${name}" is not a book of this import.`);
    }
    this.staged.delete(previewId);
    return s;
  }

  cancel(previewId: string): void { this.staged.delete(previewId); }
}

export type InstallVia = (fileName: string, contentBase64: string) => ImportPackResult;
