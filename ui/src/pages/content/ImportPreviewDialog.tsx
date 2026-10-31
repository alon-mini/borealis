import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import type { ContentProgress, ImportPreview, BookRuleset, PreviewBook, UnresolvedRef } from "../../api/contract";
import { Alert, Button, Modal, ProgressBar, useConfirm, useToast } from "../../components";
import { ComboBox, Expander } from "../../components/controls";
import { BOTH_HELP, EDITION_OPTIONS } from "./BookEdition";
import { useApi } from "../../state/ApiContext";
import { closeInstallReport, dismissImportPreview, setImportBusy, showInstallReport, useImportPreviewState } from "../../state/importPreview";
import { errorMessage } from "../../state/useAsync";
import { addIndexSource } from "./addIndexSource";
import { sourceConsentText } from "./IndexesTab";
import { ImportIssues } from "./ImportIssues";
import { ImportReportDialog } from "./ImportReportDialog";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One unresolved id: who uses it, in which files, and (issue 8) the loaded book its id names but that lacks it. */
function RefItem({ u }: { u: UnresolvedRef }) {
  const more = u.count > u.referencedBy.length ? ` and ${u.count - u.referencedBy.length} more` : "";
  return (
    <li>{u.target}
      <span className="muted small"> used by {u.referencedBy.join(", ")}{more}{u.files.length > 0 && ` (${u.files.join(", ")})`}</span>
      {u.knownSource && <span className="muted small"> {u.knownSource} is loaded but has no element with this id: it may be misspelled, or a file of that book is missing.</span>}
    </li>
  );
}

/** IM14: each book of the import with its rules edition, which the user may change before Install. */
function BookEditions({ books, chosen, onChange }: { books: PreviewBook[]; chosen: Record<string, BookRuleset>; onChange: (name: string, r: BookRuleset) => void }) {
  return (
    <fieldset className="v4-imp-books" aria-label="Books and their rules edition">
      <legend>Rules edition</legend>
      <p className="muted small">Each book is 2014 rules unless it says otherwise: its &quot;D&amp;D 5.5e&quot; mark, or its name or description saying 2024, makes it 2024; naming both editions makes it Both editions. {BOTH_HELP} Change a wrong guess here or later on the Sources page.</p>
      {books.map((b, i) => (
        <div key={b.name} className="v4-imp-book">
          <label htmlFor={`v4-imp-book-${i}`}>{b.name}</label>
          <ComboBox id={`v4-imp-book-${i}`} options={EDITION_OPTIONS} value={chosen[b.name] ?? b.edition} onChange={(e) => onChange(b.name, e.target.value as BookRuleset)} />
          {b.setByUser && <span className="muted small">your earlier choice</span>}
        </div>
      ))}
    </fieldset>
  );
}

/** What an import would add, shown before anything is installed: counts by type, grouped problems, unresolved references. */
export function ImportPreviewDialog({ preview }: { preview: ImportPreview }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { busy } = useImportPreviewState();
  const none = preview.converted === 0;
  const confirm = useConfirm();
  const source = none ? preview.indexUrl : undefined;
  const [progress, setProgress] = useState<ContentProgress | null>(null);
  useEffect(() => api.subscribe("content:progress", setProgress), [api]);
  /** A lone .index has nothing to import here: add it as a content source and download what it lists, as Indexes > Fetch does. */
  const addSource = async () => {
    if (!source) return;
    const host = new URL(source).host;
    const known = (await api.listIndexes().catch(() => [])).some((i) => i.url === source);
    if (!known && (await confirm({ title: "Add content source", body: sourceConsentText(host), confirmLabel: "Add source" })) !== "confirm") return;
    setImportBusy(true);
    const r = await addIndexSource(api, source);
    toast.push(r.text, r.tone);
    if (r.tone === "error") { setImportBusy(false); return; }
    dismissImportPreview(api);
    navigate("/content");
  };
  const [editions, setEditions] = useState<Record<string, BookRuleset>>({});
  const install = async () => {
    setImportBusy(true);
    try {
      const changed = Object.fromEntries(preview.books.filter((b) => editions[b.name] && editions[b.name] !== b.edition).map((b) => [b.name, editions[b.name]!]));
      const r = await api.installImportPreview({ previewId: preview.previewId, ...(Object.keys(changed).length ? { editions: changed } : {}) });
      toast.push(r.pack ? `Imported "${r.pack.name}" (${plural(r.report.converted, "element")}).` : "Nothing was imported.", r.pack ? "info" : "error");
      showInstallReport(r.report);
      navigate("/content");
    } catch (e) { setImportBusy(false); toast.push(errorMessage(e), "error"); }
  };
  const { errors, warnings } = preview.summary;
  return (
    <Modal title="Import preview" wide className="aur-rep-dlg" onClose={() => dismissImportPreview(api)}
      footer={<><Button onClick={() => dismissImportPreview(api)}>Cancel</Button>{source
        ? <Button variant="primary" disabled={busy} onClick={() => void addSource()}>Add as source</Button>
        : <Button variant="primary" disabled={none || busy} onClick={() => void install()}>Install</Button>}</>}>
      <div className="stack">
        <Alert tone={none ? "danger" : errors ? "warning" : "success"}>
          {source ? `${preview.packName} lists files to download. Add it as a content source to get them.` : none ? `Nothing in ${preview.packName} can be imported.` : `${plural(preview.converted, "element")} from ${plural(preview.fileCount, "file")} will be added as "${preview.packName}".`}
          {!none && preview.skipped > 0 && ` ${preview.skipped} skipped.`}
        </Alert>
        {source && busy && progress && progress.phase !== "done" && <div><ProgressBar label="Update progress" value={progress.done} max={Math.max(1, progress.total)} /><span className="small muted" role="status">{progress.message}</span></div>}
        {preview.replacesExisting && !none && <Alert tone="warning">An installed pack named "{preview.packName}" will be replaced.</Alert>}
        {!none && preview.books.length > 0 && <BookEditions books={preview.books} chosen={editions} onChange={(name, r) => setEditions({ ...editions, [name]: r })} />}
        {preview.counts.length > 0 && (
          <Expander title="Converted">
            <ul className="v4-impcounts" aria-label="Converted elements">
              {preview.counts.map((c) => <li key={c.type}><span>{c.type}</span><strong>{c.count}</strong></li>)}
            </ul>
          </Expander>
        )}
        {(errors > 0 || warnings > 0 || preview.summary.infos > 0) && (
          <p className="muted" role="status">{plural(errors, "error")}, {plural(warnings, "warning")}, {plural(preview.summary.infos, "note")}.</p>
        )}
        <ImportIssues issues={preview.diagnostics} />
        {preview.diagnosticsTruncated && <p className="muted small">Only the first problems are listed.</p>}
        {preview.unresolvedTotal > 0 && (
          <Expander title={`Unresolved references (${preview.unresolvedTotal})`} defaultOpen>
            <p>Neither this import nor your installed content has these ids, so what uses them will be missing. Import the content they come from, or install anyway and add it later.</p>
            <ul className="v4-impdiag" aria-label="Unresolved references">
              {preview.unresolved.map((u) => <RefItem key={u.target} u={u} />)}
            </ul>
          </Expander>
        )}
        {preview.conditionsTotal > 0 && (
          <Expander title={`Conditions on content you don't have (${preview.conditionsTotal})`} defaultOpen={false}>
            <p>Requirements that test for these ids work as written without them (for example &quot;not a Darkmarked character&quot;), so nothing is missing. They matter only once you add the content that defines them.</p>
            <ul className="v4-impdiag" aria-label="Conditions on content you don't have">
              {preview.conditions.map((u) => <RefItem key={u.target} u={u} />)}
            </ul>
          </Expander>
        )}
      </div>
    </Modal>
  );
}

/** Mounted once (by GlobalImport) so every entry point opens the same dialog; then the install report when it has issues. */
export function ImportPreviewHost() {
  const { preview, report } = useImportPreviewState();
  if (preview) return <ImportPreviewDialog preview={preview} />;
  return report ? <ImportReportDialog title="Import report" reports={[report]} onClose={closeInstallReport} /> : null;
}
