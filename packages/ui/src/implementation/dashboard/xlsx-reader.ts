import { Unzip, UnzipInflate, UnzipPassThrough, type UnzipFile } from "fflate";

/** The most bytes a workbook may expand to, counted as they are produced, not as headers claim. */
export const maxXlsxExpandedBytes = 50 * 1024 * 1024;
/** Rows and columns kept from one sheet, so a sparse reference cannot allocate without bound. */
export const maxSheetRows = 100_000;
export const maxSheetColumns = 1000;

/** A workbook that cannot be read; the message is written for the person looking at the drawer. */
export class XlsxError extends Error {
  override readonly name = "XlsxError";
}

export interface Sheet {
  /** Rows that hold at least one cell, in order. Cells are display text; missing ones are "". */
  readonly rows: readonly (readonly string[])[];
  /** The spreadsheet row number of each entry in `rows`. */
  readonly rowNumbers: readonly number[];
  /** Whether rows or columns beyond the kept limits were left out. */
  readonly truncated: boolean;
}

export interface Workbook {
  readonly sheetNames: readonly string[];
  /** Parse one sheet. The result is cached, so a second call is free. */
  readonly readSheet: (index: number) => Sheet;
}

const mainNamespace = "*";
const relationshipsNamespace =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const corrupt = "This workbook is damaged or is not a valid .xlsx file, so it cannot be previewed.";
const overBudget =
  "This workbook expands to more than 50 MiB, so it cannot be previewed. Download it to open it.";

const fixedParts = new Set([
  "xl/workbook.xml",
  "xl/_rels/workbook.xml.rels",
  "xl/sharedStrings.xml",
  "xl/styles.xml",
]);
const worksheetPart = /^xl\/worksheets\/[^/]+\.xml$/u;

/** Compressed bytes handed to the inflater at a time. Deflate expands at most about 1000 times. */
const sliceBytes = 16 * 1024;
const slicesPerYield = 64;

const yieldToBrowser = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Inflate only the parts a preview reads. Output is counted per chunk as it is produced and the
 * read stops at the budget; the sizes in the archive's headers are never trusted. Input is fed in
 * small slices so one slice cannot expand past the budget by much before it is counted.
 */
async function extractParts(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const finished = new Map<string, Uint8Array>();
  let produced = 0;
  let failure: XlsxError | undefined;
  const fail = (error: XlsxError) => {
    failure ??= error;
  };
  const unzip = new Unzip((file: UnzipFile) => {
    if (failure !== undefined) return;
    if (!fixedParts.has(file.name) && !worksheetPart.test(file.name)) return;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (failure !== undefined) return;
      if (error !== null) return fail(new XlsxError(corrupt));
      produced += chunk.length;
      if (produced > maxXlsxExpandedBytes) {
        file.terminate();
        return fail(new XlsxError(overBudget));
      }
      chunks.push(chunk);
      if (!final) return;
      const joined = new Uint8Array(chunks.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of chunks) {
        joined.set(part, offset);
        offset += part.length;
      }
      finished.set(file.name, joined);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.register(UnzipPassThrough);
  try {
    for (let offset = 0, slices = 0; offset < bytes.length && failure === undefined; slices += 1) {
      const end = Math.min(offset + sliceBytes, bytes.length);
      unzip.push(bytes.subarray(offset, end), end === bytes.length);
      offset = end;
      if (slices % slicesPerYield === slicesPerYield - 1) await yieldToBrowser();
    }
  } catch {
    fail(new XlsxError(corrupt));
  }
  if (failure !== undefined) throw failure;
  return finished;
}

const decoder = new TextDecoder("utf-8");

/** Parse an XML part. Documents with a DTD are refused, so no entity can be expanded. */
function parseXml(part: Uint8Array): Document {
  const text = decoder.decode(part);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw new XlsxError(corrupt);
  const document = new DOMParser().parseFromString(text, "application/xml");
  if (document.getElementsByTagName("parsererror").length > 0) throw new XlsxError(corrupt);
  return document;
}

const elements = (parent: Document | Element, name: string) =>
  Array.from(parent.getElementsByTagNameNS(mainNamespace, name));

/** The text of a shared or inline string: its plain and rich runs, without phonetic hints. */
function stringText(item: Element): string {
  let text = "";
  for (const run of elements(item, "t")) {
    let skipped = false;
    for (let parent = run.parentElement; parent !== null && parent !== item;) {
      if (parent.localName === "rPh") skipped = true;
      parent = parent.parentElement;
    }
    if (!skipped) text += run.textContent ?? "";
  }
  return text;
}

const builtInDateFormats = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

/** Whether a custom number format shows a date or time, ignoring quoted text and [color] blocks. */
export function isDateFormat(code: string): boolean {
  const bare = code
    .replace(/"[^"]*"/gu, "")
    .replace(/\[[^\]]*\]/gu, "")
    .replace(/\\./gu, "")
    .replace(/[_*]./gu, "");
  return /[dmyhs]/iu.test(bare);
}

const pad = (value: number, length = 2) => String(value).padStart(length, "0");

/** A spreadsheet serial date as YYYY-MM-DD, with HH:MM when it has a time of day. */
export function formatSerialDate(serial: number, date1904: boolean): string | undefined {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return undefined;
  // The 1900 system counts a 29 February 1900 that never existed, so serials from 61 are one high.
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, serial < 61 ? 31 : 30);
  const seconds = Math.round(serial * 86_400);
  const days = Math.floor(seconds / 86_400);
  const inDay = seconds - days * 86_400;
  const moment = new Date(epoch + days * 86_400_000);
  const time = `${pad(Math.floor(inDay / 3600))}:${pad(Math.floor((inDay % 3600) / 60))}`;
  if (serial < 1) return time;
  const day = `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}`;
  return inDay === 0 ? day : `${day} ${time}`;
}

const columnIndex = (letters: string) => {
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
};

const cellReference = /^([A-Z]+)(\d+)?$/u;

const resolveTarget = (target: string) => {
  if (target.startsWith("/")) return target.slice(1);
  const parts = ["xl"];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "." && part !== "") parts.push(part);
  }
  return parts.join("/");
};

/** The styles that show dates: for each cell format index, whether its number format is a date. */
function dateStyles(parts: Map<string, Uint8Array>): readonly boolean[] {
  const styles = parts.get("xl/styles.xml");
  if (styles === undefined) return [];
  const document = parseXml(styles);
  const custom = new Map<number, string>();
  for (const format of elements(document, "numFmt"))
    custom.set(Number(format.getAttribute("numFmtId")), format.getAttribute("formatCode") ?? "");
  const [cellXfs] = elements(document, "cellXfs");
  if (cellXfs === undefined) return [];
  return Array.from(cellXfs.children, (xf) => {
    const id = Number(xf.getAttribute("numFmtId"));
    const code = custom.get(id);
    return code === undefined ? builtInDateFormats.has(id) : isDateFormat(code);
  });
}

/**
 * Read an .xlsx workbook: sheet names in order, shared strings, number formats that show dates,
 * and each sheet's cells by their A1 reference. Formatting and merged cells are ignored. Sheets
 * are parsed when first asked for.
 */
export async function readWorkbook(buffer: ArrayBuffer): Promise<Workbook> {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new XlsxError(corrupt);
  const parts = await extractParts(bytes);
  const workbookPart = parts.get("xl/workbook.xml");
  const relationshipsPart = parts.get("xl/_rels/workbook.xml.rels");
  if (workbookPart === undefined || relationshipsPart === undefined) throw new XlsxError(corrupt);
  const workbook = parseXml(workbookPart);
  const targets = new Map<string, string>();
  for (const relationship of elements(parseXml(relationshipsPart), "Relationship"))
    targets.set(
      relationship.getAttribute("Id") ?? "",
      resolveTarget(relationship.getAttribute("Target") ?? ""),
    );
  const date1904 = ["1", "true"].includes(
    elements(workbook, "workbookPr")[0]?.getAttribute("date1904") ?? "",
  );
  const sheets = elements(workbook, "sheet").map((sheet, index) => ({
    name: sheet.getAttribute("name") || `Sheet${index + 1}`,
    part:
      targets.get(
        sheet.getAttributeNS(relationshipsNamespace, "id") ?? sheet.getAttribute("r:id") ?? "",
      ) ?? "",
  }));
  if (sheets.length === 0) throw new XlsxError(corrupt);
  const sharedPart = parts.get("xl/sharedStrings.xml");
  const shared =
    sharedPart === undefined ? [] : elements(parseXml(sharedPart), "si").map(stringText);
  const isDateStyle = dateStyles(parts);
  const cache = new Map<number, Sheet>();

  const readSheet = (index: number): Sheet => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const part = parts.get(sheets[index]?.part ?? "");
    if (part === undefined) throw new XlsxError(corrupt);
    const document = parseXml(part);
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;
    let lastRow = 0;
    for (const row of elements(document, "row")) {
      lastRow = Number(row.getAttribute("r")) || lastRow + 1;
      const cells: string[] = [];
      let lastColumn = -1;
      for (const cell of Array.from(row.children)) {
        if (cell.localName !== "c") continue;
        const match = cellReference.exec(cell.getAttribute("r") ?? "");
        const column = match?.[1] === undefined ? lastColumn + 1 : columnIndex(match[1]);
        lastColumn = column;
        if (column >= maxSheetColumns) {
          truncated = true;
          continue;
        }
        const value = cellText(cell);
        if (value === "") continue;
        while (cells.length < column) cells.push("");
        cells[column] = value;
      }
      if (cells.length === 0) continue;
      if (rows.length >= maxSheetRows) {
        truncated = true;
        break;
      }
      rows.push(cells);
      rowNumbers.push(lastRow);
    }
    const sheet = { rows, rowNumbers, truncated };
    cache.set(index, sheet);
    return sheet;
  };

  const cellText = (cell: Element): string => {
    const type = cell.getAttribute("t") ?? "n";
    if (type === "inlineStr") {
      const inline = elements(cell, "is")[0];
      return inline === undefined ? "" : stringText(inline);
    }
    const raw = elements(cell, "v")[0]?.textContent ?? "";
    if (raw === "") return "";
    switch (type) {
      case "s":
        return shared[Number(raw)] ?? "";
      case "b":
        return raw === "1" || raw === "true" ? "TRUE" : "FALSE";
      case "n": {
        if (isDateStyle[Number(cell.getAttribute("s") ?? 0)] !== true) return raw;
        return formatSerialDate(Number(raw), date1904) ?? raw;
      }
      default:
        // str, e (an error such as #DIV/0!) and anything else show their stored text.
        return raw;
    }
  };

  return { sheetNames: sheets.map((sheet) => sheet.name), readSheet };
}
