import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockApi } from "../api/mock";
import { closeImportPreview } from "../state/importPreview";
import { renderApp } from "./utils";

// GitHub #11 (decision IM17): a book is guessed 2024 only when it says so (its "D&D 5.5e" mark, or its name or description
// saying 2024 / 5.5e / One D&D), never from its date; a book that names both editions is guessed Both editions, offered to
// 2014 and 2024 characters. The Sources page and the import preview offer a third choice, "Both editions".
const mock = () => new MockApi({ aiChunkDelayMs: 1, rng: () => 0.5 });
const book = (name: string, setters: string, abbr: string, description = "") =>
  `<elements><element name="${name}" type="Source" source="Core" id="ID_${abbr}_SOURCE"><description>${description}</description><setters>${setters}</setters></element>` +
  `<element name="${abbr} Feat" type="Feat" source="${name}" id="ID_${abbr}_FEAT"/></elements>`;

describe("IM17 Sources page", () => {
  it("offers Both editions with a short explanation", async () => {
    const user = userEvent.setup();
    const api = mock();
    const set = vi.spyOn(api, "setSourceEdition");
    renderApp("/content/sources", { api });
    const grid = await screen.findByRole("grid", { name: "Sources" });
    await user.click(within(grid).getByText("Sample Expansion", { selector: ".nm" }));
    const edition = await screen.findByRole("combobox", { name: "Rules edition of this book" });
    expect(within(edition).getAllByRole("option").map((o) => o.textContent)).toEqual(["2014 rules", "2024 rules", "Both editions"]);
    expect(screen.getByText(/Both editions: offered to 2014 and 2024 characters\./)).toBeTruthy();
    await user.selectOptions(edition, "any");
    await waitFor(() => expect(set).toHaveBeenCalledWith({ sourceId: expect.any(String), edition: "any" }));
    expect(((await screen.findByRole("combobox", { name: "Rules edition of this book" })) as HTMLSelectElement).value).toBe("any");
  });
});

describe("IM17 import preview", () => {
  beforeEach(() => closeImportPreview());

  it("guesses 2024 only from what the book says, Both when it names both, and never from its date", async () => {
    const user = userEvent.setup();
    const api = mock();
    const install = vi.spyOn(api, "installImportPreview");
    renderApp("/content", { api });
    await screen.findByRole("button", { name: "Import files" });
    fireEvent.change(screen.getByLabelText("Choose content files"), { target: { files: [
      new File([book("Grim Test: Player's Guide (2025)", "<set name=\"third-party\">true</set><set name=\"release\">20250115</set>", "GT")], "grim.xml"),
      new File([book("Test Classes 2014/2024", "", "BT")], "both.xml"),
      new File([book("Said Homebrew", "", "SH", "<p>Classes for the 5.5e rules.</p>")], "said.xml"),
    ] } });
    const dialog = await screen.findByRole("dialog", { name: /Import preview/ });
    const books = within(dialog).getByRole("group", { name: "Books and their rules edition" });
    const value = (name: string) => (within(books).getByRole("combobox", { name }) as HTMLSelectElement).value;
    expect([value("Grim Test: Player's Guide (2025)"), value("Test Classes 2014/2024"), value("Said Homebrew")]).toEqual(["dnd2014", "any", "dnd2024"]);
    expect(books.textContent).toContain("Both editions");
    await user.selectOptions(within(books).getByRole("combobox", { name: "Grim Test: Player's Guide (2025)" }), "any");
    await user.click(within(dialog).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(install).toHaveBeenCalledWith({ previewId: expect.any(String), editions: { "Grim Test: Player's Guide (2025)": "any" } }));
  });
});
