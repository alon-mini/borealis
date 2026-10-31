import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockApi } from "../api/mock";
import { closeImportPreview } from "../state/importPreview";
import { renderApp } from "./utils";

// GitHub #11 (decision IM14, guess per IM17): the user sets each imported book's edition on the Sources page and in the
// import preview. The preview pre-fills the "D&D 5.5e" marker or what the book says (never its date, IM17); only books
// the user changes are sent. Bundled books keep their edition.
const mock = () => new MockApi({ aiChunkDelayMs: 1, rng: () => 0.5 });
const source = (name: string, setters: string) =>
  `<element name="${name}" type="Source" source="Core" id="ID_${name.length}_SOURCE"><setters>${setters}</setters></element>`;
const book = (name: string, setters: string, abbr: string) =>
  `<elements>${source(name, setters)}<element name="${abbr} Feat" type="Feat" source="${name}" id="ID_${abbr}_FEAT"/></elements>`;

describe("IM14 Sources page", () => {
  it("an imported book's edition can be set, and says where it came from", async () => {
    const user = userEvent.setup();
    const api = mock();
    const set = vi.spyOn(api, "setSourceEdition");
    renderApp("/content/sources", { api });
    const grid = await screen.findByRole("grid", { name: "Sources" });
    await user.click(within(grid).getByText("Sample Expansion", { selector: ".nm" }));
    const edition = await screen.findByRole("combobox", { name: "Rules edition of this book" });
    expect((edition as HTMLSelectElement).value).toBe("dnd2024");
    expect(screen.getByText(/Found in the book: its .D&D 5\.5e. mark, or its name or description\./)).toBeTruthy();
    await user.selectOptions(edition, "dnd2014");
    await waitFor(() => expect(set).toHaveBeenCalledWith({ sourceId: expect.any(String), edition: "dnd2014" }));
    expect(await screen.findByText(/Set by you\./)).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Rules edition of this book" }) as HTMLSelectElement).value).toBe("dnd2014");
    expect(screen.getByText(/Characters that already use this book keep its content/)).toBeTruthy();
  });

  it("a bundled book shows its edition but cannot be changed", async () => {
    const user = userEvent.setup();
    renderApp("/content/sources", { api: mock() });
    const grid = await screen.findByRole("grid", { name: "Sources" });
    await user.click(within(grid).getByText("Sample Reference 5.1", { selector: ".nm" }));
    await screen.findByText(/Rules edition: 2014/);
    expect(screen.queryByRole("combobox", { name: "Rules edition of this book" })).toBeNull();
  });
});

describe("IM14 import preview", () => {
  beforeEach(() => closeImportPreview());

  it("lists each book with its detected edition and installs the ones the user changed", async () => {
    const user = userEvent.setup();
    const api = mock();
    const install = vi.spyOn(api, "installImportPreview");
    renderApp("/content", { api });
    await screen.findByRole("button", { name: "Import files" });
    fireEvent.change(screen.getByLabelText("Choose content files"), { target: { files: [
      new File([book("Grim Test: Player's Guide (2025)", "<set name=\"third-party\">true</set><set name=\"information\">D&amp;D 5.5e</set>", "GT")], "grim.xml"),
      new File([book("Old Test Homebrew", "<set name=\"release\">20230101</set>", "OT")], "old.xml"),
    ] } });
    const dialog = await screen.findByRole("dialog", { name: /Import preview/ });
    const books = within(dialog).getByRole("group", { name: "Books and their rules edition" });
    const grim = within(books).getByRole("combobox", { name: "Grim Test: Player's Guide (2025)" }) as HTMLSelectElement;
    const old = within(books).getByRole("combobox", { name: "Old Test Homebrew" }) as HTMLSelectElement;
    expect([grim.value, old.value]).toEqual(["dnd2024", "dnd2014"]);
    expect(books.textContent).toContain("its name or description saying 2024");
    await user.selectOptions(old, "dnd2024");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith({ previewId: expect.any(String), editions: { "Old Test Homebrew": "dnd2024" } }));
  });
});
