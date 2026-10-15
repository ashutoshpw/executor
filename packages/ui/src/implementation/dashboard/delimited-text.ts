/** The field delimiter of a delimited text file. */
export type Delimiter = "," | "\t";

const unquotedRun = {
  ",": /[^,\r\n]+/y,
  "\t": /[^\t\r\n]+/y,
} as const;

/**
 * Parse RFC 4180 delimited text into rows of fields. Fields may be quoted, a doubled quote inside
 * one is a quote, and a quoted field may hold the delimiter and line breaks. CRLF, LF and CR all end
 * a row. A leading byte order mark is dropped and blank lines are skipped. Rows may differ in
 * length; an unterminated quote runs to the end of the text.
 */
export function parseDelimited(text: string, delimiter: Delimiter): string[][] {
  const rows: string[][] = [];
  const run = unquotedRun[delimiter];
  const delimiterCode = delimiter.charCodeAt(0);
  let row: string[] = [];
  let field = "";
  let start = true;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const endRow = () => {
    row.push(field);
    field = "";
    // A line with nothing on it is not a row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    start = true;
  };
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (start && code === 34) {
      index += 1;
      for (;;) {
        const quote = text.indexOf('"', index);
        if (quote === -1) {
          field += text.slice(index);
          index = text.length;
          break;
        }
        field += text.slice(index, quote);
        if (text.charCodeAt(quote + 1) === 34) {
          field += '"';
          index = quote + 2;
          continue;
        }
        index = quote + 1;
        break;
      }
      start = false;
    } else if (code === delimiterCode) {
      row.push(field);
      field = "";
      start = true;
      index += 1;
    } else if (code === 10 || code === 13) {
      endRow();
      index += code === 13 && text.charCodeAt(index + 1) === 10 ? 2 : 1;
    } else {
      run.lastIndex = index;
      const match = run.exec(text);
      // The run stops at the delimiter or a line break, so a match is always non-empty here. A
      // stray quote after a closing quote is kept as text.
      const piece = match?.[0] ?? text[index]!;
      field += piece;
      index += piece.length;
      start = false;
    }
  }
  if (!start || field !== "" || row.length > 0) endRow();
  return rows;
}
