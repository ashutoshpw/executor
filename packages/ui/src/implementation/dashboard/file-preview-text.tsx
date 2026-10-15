"use client";

import { useMemo, useState } from "react";
import { Button } from "../components/button.tsx";
import { PreviewToolbar } from "./file-preview-controls.tsx";

/** The charset parameter of a content type, or undefined. */
const charsetOf = (contentType: string) =>
  /;\s*charset\s*=\s*"?([^";\s]+)"?/iu.exec(contentType)?.[1];

/**
 * Decode text bytes with the charset the content type names, or UTF-8 when it names none or one
 * this browser does not know. A byte order mark is dropped. With `partial`, a multibyte character
 * cut off at the end of the bytes is left out, not turned into a replacement character.
 */
export function decodeText(bytes: ArrayBuffer, contentType: string, partial: boolean): string {
  const label = charsetOf(contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label ?? "utf-8");
  } catch {
    // An unknown label is a mistake in the file's metadata, not a reason to show nothing.
    decoder = new TextDecoder("utf-8");
  }
  const text = decoder.decode(new Uint8Array(bytes), { stream: partial });
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Lines are mounted this many at a time, so a long file cannot flood the page. */
const linesPerPage = 2000;

/** Split text into lines on LF, CRLF or CR. A final line break does not start another line. */
const splitLines = (text: string) => {
  const lines = text.split(/\r\n|\r|\n/u);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Monospace text with line numbers, a wrap toggle and the line count. */
export function TextView({
  text,
  note,
}: {
  readonly text: string;
  /** A line above the text, for instance that the file was cut short. */
  readonly note?: React.ReactNode;
}) {
  const [wrap, setWrap] = useState(false);
  const [shown, setShown] = useState(linesPerPage);
  const lines = useMemo(() => splitLines(text), [text]);
  const gutter = `${String(lines.length).length + 1}ch`;
  return (
    <>
      <PreviewToolbar>
        <span data-line-count>
          {lines.length.toLocaleString("en-US")} {lines.length === 1 ? "line" : "lines"}
        </span>
        <span className="flex-1" />
        <Button
          variant={wrap ? "secondary" : "outline"}
          size="xs"
          aria-pressed={wrap}
          onClick={() => setWrap((current) => !current)}
        >
          Wrap
        </Button>
      </PreviewToolbar>
      {note}
      <div
        role="region"
        aria-label="File text"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto py-2 font-mono text-[12px] leading-[1.6] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <div className={wrap ? "" : "w-max min-w-full"}>
          {lines.slice(0, shown).map((line, index) => (
            <div key={index} className="flex">
              <span
                aria-hidden
                data-line-number
                style={{ minWidth: gutter }}
                className="sticky left-0 box-content shrink-0 bg-background px-3 text-right text-muted-foreground tabular-nums select-none"
              >
                {index + 1}
              </span>
              <span className={wrap ? "min-w-0 break-words whitespace-pre-wrap" : "whitespace-pre"}>
                {line === "" ? " " : line}
              </span>
            </div>
          ))}
        </div>
        {shown < lines.length && (
          <div className="px-4 py-3">
            <Button
              variant="outline"
              size="xs"
              onClick={() => setShown((count) => count + linesPerPage)}
            >
              Show more lines
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

/** The banner above a file that was cut at the preview limit. */
export function TruncationNote({ children }: { readonly children: React.ReactNode }) {
  return (
    <p
      role="note"
      data-truncated
      className="border-b bg-muted/50 px-4 py-2 text-xs text-muted-foreground"
    >
      {children}
    </p>
  );
}
