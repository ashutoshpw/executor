"use client";

import { useEffect, useMemo, useState } from "react";
import { Skeleton } from "../components/skeleton.tsx";
import { Spinner } from "../components/spinner.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import { parseDelimited, type Delimiter } from "./delimited-text.ts";
import { Notice, PreviewToolbar, ViewSwitch } from "./file-preview-controls.tsx";
import { columnName, PreviewTable } from "./file-preview-table.tsx";
import { decodeText, TextView, TruncationNote } from "./file-preview-text.tsx";
import type { Sheet, Workbook } from "./xlsx-reader.ts";

type ImageFit = "fit" | "actual";

const imageFits = [
  { value: "fit", label: "Fit" },
  { value: "actual", label: "Actual size" },
] as const;

/** A faint checkerboard, so transparent pixels read as transparent. */
const checkerboard = {
  background:
    "repeating-conic-gradient(color-mix(in oklab, var(--foreground) 7%, transparent) 0% 25%, transparent 0% 50%) 50% / 16px 16px",
} as const;

/**
 * Show an image straight from its signed link, without buffering it. The browser decodes it in an
 * img element, where an SVG's scripts do not run; the file is never inlined or framed.
 */
export function ImageViewer({ mintLink }: { readonly mintLink: () => Promise<string> }) {
  const [url, setUrl] = useState<string>();
  const [size, setSize] = useState<{ readonly width: number; readonly height: number }>();
  const [failure, setFailure] = useState<string>();
  const [fit, setFit] = useState<ImageFit>("fit");

  useEffect(() => {
    let cancelled = false;
    mintLink().then(
      (link) => {
        if (!cancelled) setUrl(link);
      },
      (cause) => {
        if (!cancelled)
          setFailure(cause instanceof Error ? cause.message : "Could not create a link.");
      },
    );
    return () => {
      cancelled = true;
    };
    // The link is minted once per opened file; the caller's closure may change every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failure !== undefined) return <Notice>{failure}</Notice>;
  return (
    <>
      <PreviewToolbar>
        <span data-image-size aria-live="polite">
          {size === undefined ? "" : `${size.width} × ${size.height}`}
        </span>
        <span className="flex-1" />
        <ViewSwitch label="Image size" options={imageFits} value={fit} onChange={setFit} />
      </PreviewToolbar>
      <div className="relative min-h-0 flex-1 overflow-auto" style={checkerboard}>
        <div
          className={
            fit === "fit"
              ? "absolute inset-0 flex items-center justify-center p-4"
              : "flex min-h-full w-max min-w-full p-4"
          }
        >
          {size === undefined && (
            <Skeleton
              role="status"
              aria-label="Loading image"
              className="absolute top-1/2 left-1/2 size-1/2 -translate-x-1/2 -translate-y-1/2"
            />
          )}
          {url !== undefined && (
            <img
              src={url}
              alt="Preview of the file"
              // No referrer: the link is a bearer secret.
              referrerPolicy="no-referrer"
              decoding="async"
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                setSize({ width: naturalWidth, height: naturalHeight });
              }}
              onError={() =>
                setFailure(
                  "This image format can't be shown in the browser. Download it to open it.",
                )
              }
              onClick={() => setFit((current) => (current === "fit" ? "actual" : "fit"))}
              className={`${size === undefined ? "opacity-0" : ""} ${
                fit === "fit"
                  ? "max-h-full max-w-full cursor-zoom-in object-contain"
                  : "m-auto max-w-none cursor-zoom-out"
              }`}
            />
          )}
        </div>
      </div>
    </>
  );
}

const delimitedViews = [
  { value: "table", label: "Table" },
  { value: "raw", label: "Raw" },
] as const;

/** CSV or TSV as a table, or as its text. The first row is the header. */
export function DelimitedViewer({
  bytes,
  contentType,
  delimiter,
  truncation,
}: {
  readonly bytes: ArrayBuffer;
  readonly contentType: string;
  readonly delimiter: Delimiter;
  /** Why the file is cut short, or undefined when it is whole. */
  readonly truncation: string | undefined;
}) {
  const truncated = truncation !== undefined;
  const [view, setView] = useState<"table" | "raw">("table");
  const text = useMemo(
    () => decodeText(bytes, contentType, truncated),
    [bytes, contentType, truncated],
  );
  const rows = useMemo(() => {
    const parsed = parseDelimited(text, delimiter);
    // The last row of a cut file may be partial.
    if (truncated) parsed.pop();
    return parsed;
  }, [text, delimiter, truncated]);
  if (view === "raw")
    return (
      <>
        <PreviewToolbar>
          <ViewSwitch label="Data view" options={delimitedViews} value={view} onChange={setView} />
        </PreviewToolbar>
        <TextView
          text={text}
          note={truncated ? <TruncationNote>{truncation}</TruncationNote> : undefined}
        />
      </>
    );
  return (
    <>
      <PreviewToolbar>
        <ViewSwitch label="Data view" options={delimitedViews} value={view} onChange={setView} />
      </PreviewToolbar>
      {rows.length === 0 ? (
        <Notice>This file has no rows.</Notice>
      ) : (
        <PreviewTable
          label="Table"
          header={rows[0]!}
          rows={rows.slice(1)}
          note={truncated ? <span data-truncated>{truncation}</span> : undefined}
        />
      )}
    </>
  );
}

type Opened =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly workbook: Workbook }
  | { readonly status: "error"; readonly message: string };

/** A workbook's sheets as tabs over one grid, with spreadsheet column letters and row numbers. */
export function XlsxViewer({ bytes }: { readonly bytes: ArrayBuffer }) {
  const [opened, setOpened] = useState<Opened>({ status: "loading" });
  const [active, setActive] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The reader and its zip library load only when a workbook opens.
        const reader = await import("./xlsx-reader.ts");
        const workbook = await reader.readWorkbook(bytes);
        if (!cancelled) setOpened({ status: "ready", workbook });
      } catch (cause) {
        if (!cancelled)
          setOpened({
            status: "error",
            message:
              cause instanceof Error && cause.name === "XlsxError"
                ? cause.message
                : "This workbook could not be read.",
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  if (opened.status === "error") return <Notice>{opened.message}</Notice>;
  if (opened.status === "loading")
    return (
      <Notice>
        <Spinner /> <span className="ml-2">Opening workbook…</span>
      </Notice>
    );
  return (
    <Tabs
      value={String(active)}
      onValueChange={(value) => setActive(Number(value))}
      className="min-h-0 flex-1 gap-0"
    >
      <div className="overflow-x-auto border-b px-4 py-2">
        <TabsList aria-label="Sheets">
          {opened.workbook.sheetNames.map((name, index) => (
            <TabsTrigger key={index} value={String(index)} className="flex-none">
              {name}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      <TabsContent value={String(active)} className="flex min-h-0 flex-1 flex-col">
        <SheetGrid key={active} workbook={opened.workbook} index={active} />
      </TabsContent>
    </Tabs>
  );
}

function SheetGrid({ workbook, index }: { readonly workbook: Workbook; readonly index: number }) {
  const [sheet, setSheet] = useState<Sheet | string>();
  useEffect(() => {
    // Parsed after the tab paints, so a large sheet does not delay the switch.
    const timer = setTimeout(() => {
      try {
        setSheet(workbook.readSheet(index));
      } catch (cause) {
        setSheet(cause instanceof Error ? cause.message : "This sheet could not be read.");
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [workbook, index]);
  const columns = useMemo(() => {
    if (typeof sheet !== "object") return [];
    let widest = 0;
    for (const row of sheet.rows) if (row.length > widest) widest = row.length;
    return Array.from({ length: widest }, (_, column) => columnName(column));
  }, [sheet]);
  if (sheet === undefined)
    return (
      <Notice>
        <Spinner /> <span className="ml-2">Reading sheet…</span>
      </Notice>
    );
  if (typeof sheet === "string") return <Notice>{sheet}</Notice>;
  if (sheet.rows.length === 0) return <Notice>This sheet is empty.</Notice>;
  return (
    <PreviewTable
      label="Sheet"
      header={columns}
      rows={sheet.rows}
      rowNumbers={sheet.rowNumbers}
      note={
        sheet.truncated ? (
          <TruncationNote>Rows or columns past the preview limit are left out.</TruncationNote>
        ) : undefined
      }
    />
  );
}

/** What `ExtraPreview` shows: an image by its link, or fetched bytes of a text-like kind. */
export type ExtraPreviewProps =
  | { readonly kind: "image"; readonly mintLink: () => Promise<string> }
  | {
      readonly kind: "text" | "csv" | "tsv" | "xlsx";
      readonly bytes: ArrayBuffer;
      readonly contentType: string;
      /** Why the bytes are cut short, or undefined when they are whole. */
      readonly truncation: string | undefined;
    };

/**
 * The viewers for images, text, CSV, TSV and workbooks. They live in one module that the drawer
 * loads only in a browser, so the server render and the Cloud Workers do not carry it.
 */
export function ExtraPreview(props: ExtraPreviewProps) {
  if (props.kind === "image") return <ImageViewer mintLink={props.mintLink} />;
  if (props.kind === "xlsx") return <XlsxViewer bytes={props.bytes} />;
  if (props.kind === "text")
    return (
      <TextView
        text={decodeText(props.bytes, props.contentType, props.truncation !== undefined)}
        note={
          props.truncation === undefined ? undefined : (
            <TruncationNote>{props.truncation}</TruncationNote>
          )
        }
      />
    );
  return (
    <DelimitedViewer
      bytes={props.bytes}
      contentType={props.contentType}
      delimiter={props.kind === "csv" ? "," : "\t"}
      truncation={props.truncation}
    />
  );
}
