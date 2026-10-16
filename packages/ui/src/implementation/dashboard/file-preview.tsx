"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Download01Icon,
  MinusSignIcon,
  SourceCodeIcon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type * as PdfJs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Button } from "../components/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/sheet.tsx";
import { Spinner } from "../components/spinner.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/tooltip.tsx";
import { CopyButton } from "./code.tsx";
import { Notice, ViewSwitch } from "./file-preview-controls.tsx";
import { ToolMarkdown } from "./markdown.tsx";
import { markdownDocument } from "./markdown-prose.ts";

/**
 * The viewers for images, text, tables and workbooks load only in a browser. The server render
 * never reaches them, and a dynamic import would still ship their chunk to the Cloud Workers.
 */
const serverRender = () => Promise.reject(new Error("File previews render only in a browser"));
const ExtraPreview = lazy(() =>
  (import.meta.env.SSR ? serverRender() : import("./file-preview-viewers.tsx")).then((module) => ({
    default: module.ExtraPreview,
  })),
);

const loadingPreview = (
  <Notice>
    <Spinner /> <span className="ml-2">Loading preview…</span>
  </Notice>
);

/** What the drawer needs to know about a file before it fetches any bytes. */
export interface PreviewFile {
  readonly id: string;
  readonly contentType: string;
  readonly size: number;
}

/** A PDF above this many bytes is downloaded, not previewed. */
export const maxPdfPreviewBytes = 25 * 1024 * 1024;
/** Markdown above this many bytes is downloaded, not previewed. */
export const maxMarkdownPreviewBytes = 1024 * 1024;

/** An HTML document above this many bytes is downloaded, not previewed. */
export const maxHtmlPreviewBytes = 1024 * 1024;

/** A workbook above this many bytes is downloaded, not previewed. */
export const maxXlsxPreviewBytes = 10 * 1024 * 1024;
/** Plain text above this many bytes is cut at it. */
export const maxTextPreviewBytes = 1024 * 1024;
/** A CSV or TSV above this many bytes is cut at it. */
export const maxDelimitedPreviewBytes = 5 * 1024 * 1024;

/**
 * Media and images stream from their link, so nothing is buffered by the page and no size cap
 * applies. The other kinds are fetched whole, up to a limit.
 */
export type PreviewKind =
  | "pdf"
  | "markdown"
  | "html"
  | "video"
  | "audio"
  | "image"
  | "text"
  | "csv"
  | "tsv"
  | "xlsx";
type BufferedKind = "pdf" | "markdown" | "html" | "text" | "csv" | "tsv" | "xlsx";

/** A media link outlives a long playback: four hours, where the default is fifteen minutes. */
export const mediaLinkSeconds = 4 * 60 * 60;

/** The previewable kind of a stored content type, or undefined. Files carry no name, so no extension. */
export const previewKind = (contentType: string): PreviewKind | undefined => {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "application/pdf" || type === "application/x-pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/csv" || type === "application/csv" || type === "text/x-csv") return "csv";
  if (type === "text/tab-separated-values" || type === "text/tsv") return "tsv";
  if (type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
  if (type?.startsWith("image/")) return "image";
  if (type?.startsWith("text/")) return "text";
  if (type === "video/mp4" || type === "video/webm" || type === "video/quicktime") return "video";
  if (type === "video/ogg") return "video";
  if (
    type === "audio/mpeg" ||
    type === "audio/mp4" ||
    type === "audio/aac" ||
    type === "audio/wav" ||
    type === "audio/x-wav" ||
    type === "audio/webm" ||
    type === "audio/ogg"
  )
    return "audio";
  return undefined;
};

const limits = {
  pdf: maxPdfPreviewBytes,
  markdown: maxMarkdownPreviewBytes,
  html: maxHtmlPreviewBytes,
  text: maxTextPreviewBytes,
  csv: maxDelimitedPreviewBytes,
  tsv: maxDelimitedPreviewBytes,
  xlsx: maxXlsxPreviewBytes,
} as const satisfies Record<BufferedKind, number>;
const limitOf = (kind: BufferedKind) => limits[kind];

/** These are cut at their limit; the others are refused above it. */
const isCutAtLimit = (kind: BufferedKind) => kind === "text" || kind === "csv" || kind === "tsv";

const isBuffered = (kind: PreviewKind | undefined): kind is BufferedKind =>
  kind !== undefined && kind !== "video" && kind !== "audio" && kind !== "image";

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

/** A size for a sentence: bytes, KiB, MiB or GiB with one decimal above a byte. */
const formatBytes = (bytes: number) => {
  const units = ["bytes", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} bytes` : `${value.toFixed(1)} ${units[unit]}`;
};

type Bytes =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly bytes: ArrayBuffer; readonly truncated: boolean }
  | { readonly status: "error"; readonly message: string };

/**
 * Read a response body, stopping as soon as it passes `limit` bytes so the cap bounds the memory
 * used, not just the final size. A body over the limit is refused (undefined), or with `cut` its
 * first `limit` bytes are kept and the rest of the transfer is cancelled.
 */
async function readWithin(
  response: Response,
  limit: number,
  cut: boolean,
  signal: AbortSignal,
): Promise<{ readonly bytes: ArrayBuffer; readonly truncated: boolean } | undefined> {
  if (response.body === null) {
    const whole = await response.arrayBuffer();
    if (whole.byteLength <= limit) return { bytes: whole, truncated: false };
    return cut ? { bytes: whole.slice(0, limit), truncated: true } : undefined;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > limit) {
        if (!cut) return undefined;
        chunks.push(value.subarray(0, limit - total));
        total = limit;
        truncated = true;
        break;
      }
      total += value.byteLength;
      chunks.push(value);
    }
  } finally {
    // Stops the transfer when the cap or an abort ended the read early.
    void reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: joined.buffer, truncated };
}

/**
 * Fetch a file's bytes through a freshly minted link. The request is aborted and the bytes
 * dropped when the drawer closes; nothing is cached across openings.
 */
function useFileBytes(
  file: PreviewFile,
  limit: number,
  cut: boolean,
  mintLink: () => Promise<string>,
): Bytes {
  const [state, setState] = useState<Bytes>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    const fail = (message: string) => {
      if (!controller.signal.aborted) setState({ status: "error", message });
    };
    void (async () => {
      let url: string;
      try {
        url = await mintLink();
      } catch (cause) {
        fail(cause instanceof Error ? cause.message : "Could not create a download link.");
        return;
      }
      if (controller.signal.aborted) return;
      try {
        // The link is a bearer secret, so no cookies or other credentials go with it.
        const response = await fetch(url, { credentials: "omit", signal: controller.signal });
        if (!response.ok) return fail(`The file could not be loaded (HTTP ${response.status}).`);
        const declared = Number(response.headers.get("content-length"));
        if (!cut && Number.isFinite(declared) && declared > limit) {
          controller.abort();
          return setState({ status: "error", message: "Too large to preview." });
        }
        const read = await readWithin(response, limit, cut, controller.signal);
        if (read === undefined) {
          controller.abort();
          return setState({ status: "error", message: "Too large to preview." });
        }
        if (!controller.signal.aborted) setState({ status: "ready", ...read });
      } catch (cause) {
        if (controller.signal.aborted) return;
        fail(
          cause instanceof Error
            ? `The file could not be loaded: ${cause.message}`
            : "The file could not be loaded.",
        );
      }
    })();
    return () => controller.abort();
    // The link is minted once per opened file; the caller's closure may change every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, limit, cut]);
  return state;
}

const startsWithPdfHeader = (bytes: ArrayBuffer) => {
  const head = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength));
  return head.length === 5 && String.fromCharCode(...head) === "%PDF-";
};

const zoomSteps = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5] as const;

/** Pages beyond this many are not mounted; the rest of the file is a download away. */
const maxPreviewPages = 300;
/** Canvas pixels allowed per page, so zoom and an extreme page shape cannot exhaust memory. */
const maxCanvasPixels = 16 * 1024 * 1024;

const isCancelledRender = (cause: unknown) =>
  cause instanceof Error && cause.name === "RenderingCancelledException";

/** One PDF page. It renders only while near the viewport and gives its canvas back when far away. */
function PdfPage({
  pdf,
  number,
  width,
  zoom,
  ratio,
  scroller,
  onCurrent,
}: {
  readonly pdf: PDFDocumentProxy;
  readonly number: number;
  readonly width: number;
  readonly zoom: number;
  readonly ratio: number;
  /** The drawer's scroll container; observers measure against it, not the page viewport. */
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly onCurrent: (page: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  // This page's own height over width once known; until then the first page's.
  const [measured, setMeasured] = useState<number>();
  const [failed, setFailed] = useState(false);
  const cssWidth = Math.max(1, Math.floor(width * zoom));
  const height = Math.max(1, Math.round(cssWidth * (measured ?? ratio)));

  useEffect(() => {
    const element = box.current;
    if (element === null) return;
    const nearObserver = new IntersectionObserver(
      (entries) => setNear(entries.some((entry) => entry.isIntersecting)),
      { root: scroller.current, rootMargin: "800px 0px" },
    );
    const currentObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onCurrent(number);
      },
      { root: scroller.current, rootMargin: "-45% 0px -45% 0px" },
    );
    nearObserver.observe(element);
    currentObserver.observe(element);
    return () => {
      nearObserver.disconnect();
      currentObserver.disconnect();
    };
  }, [number, onCurrent, scroller]);

  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    if (!near) {
      // Far from the viewport: free the pixels, keep the page's height.
      target.width = 0;
      target.height = 0;
      return;
    }
    let cancelled = false;
    let task: { cancel: () => void; promise: Promise<unknown> } | undefined;
    void (async () => {
      try {
        const page = await pdf.getPage(number);
        if (cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: cssWidth / base.width });
        setMeasured(base.height / base.width);
        setFailed(false);
        // Lower the density, down to one pixel per CSS pixel, when the canvas would be too big.
        const wanted = Math.min(window.devicePixelRatio || 1, 2);
        const fit = Math.sqrt(maxCanvasPixels / Math.max(1, viewport.width * viewport.height));
        const density = Math.max(Math.min(wanted, fit), 0.1);
        target.width = Math.floor(viewport.width * density);
        target.height = Math.floor(viewport.height * density);
        target.style.width = `${viewport.width}px`;
        target.style.height = `${viewport.height}px`;
        task = page.render({
          canvas: target,
          viewport,
          // No annotations or form widgets: they are interactive content and run no script here.
          annotationMode: 0,
          transform: density === 1 ? undefined : [density, 0, 0, density, 0, 0],
        });
        await task.promise;
      } catch (cause) {
        // A cancelled render is the normal end of a page that scrolled away or resized.
        if (!cancelled && !isCancelledRender(cause)) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, near, cssWidth]);

  return (
    <div
      ref={box}
      className="mx-auto mb-3 bg-white shadow-sm ring-1 ring-border"
      style={{ width: cssWidth, height }}
      data-page={number}
    >
      <canvas ref={canvas} aria-label={`Page ${number}`} role="img" className="block" />
      {failed && (
        <p role="alert" className="p-3 text-center text-xs text-muted-foreground">
          This page could not be rendered.
        </p>
      )}
    </div>
  );
}

/** Render PDF bytes to canvases in a scrollable column, fit to width. */
function PdfViewer({ bytes }: { readonly bytes: ArrayBuffer }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [failure, setFailure] = useState<string>();
  const [width, setWidth] = useState(0);
  const [ratio, setRatio] = useState(1.414);
  const [zoomIndex, setZoomIndex] = useState(2);
  const [current, setCurrent] = useState(1);

  useEffect(() => {
    let cancelled = false;
    let destroy: (() => Promise<void>) | undefined;
    void (async () => {
      try {
        // pdf.js and its worker are static assets fetched only when a PDF opens. They are loaded
        // by URL, not bundled, so the server render and the Workers never carry them.
        const [library, worker] = await Promise.all([
          import("pdfjs-dist/build/pdf.min.mjs?url"),
          import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
        ]);
        const pdfjs = (await import(/* @vite-ignore */ library.default)) as typeof PdfJs;
        if (cancelled) return;
        pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
        const task = pdfjs.getDocument({
          // A copy: pdf.js hands the buffer to its worker.
          data: new Uint8Array(bytes.slice(0)),
          // pdf.js 6 has no eval path to disable, and XFA forms are interactive content.
          enableXfa: false,
        });
        destroy = () => task.destroy();
        const document = await task.promise;
        if (cancelled) return;
        const first = await document.getPage(1);
        const view = first.getViewport({ scale: 1 });
        if (cancelled) return;
        setRatio(view.height / view.width);
        setPdf(document);
      } catch (cause) {
        if (!cancelled)
          setFailure(cause instanceof Error ? cause.message : "The PDF could not be read.");
      }
    })();
    return () => {
      cancelled = true;
      // Releases the document, its pages and the worker.
      void destroy?.();
    };
  }, [bytes]);

  useEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const measure = () => setWidth(Math.max(0, element.clientWidth - 32));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pdf]);

  if (failure !== undefined) return <Notice>This PDF could not be displayed: {failure}</Notice>;
  if (pdf === undefined)
    return (
      <Notice>
        <Spinner /> <span className="ml-2">Opening PDF…</span>
      </Notice>
    );
  const zoom = zoomSteps[zoomIndex] ?? 1;
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-2 text-xs text-muted-foreground">
        <span aria-live="polite">
          Page {current} of {pdf.numPages}
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom out"
          disabled={zoomIndex === 0}
          onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
        >
          <HugeiconsIcon icon={MinusSignIcon} aria-hidden />
        </Button>
        <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Zoom in"
          disabled={zoomIndex === zoomSteps.length - 1}
          onClick={() => setZoomIndex((index) => Math.min(zoomSteps.length - 1, index + 1))}
        >
          <HugeiconsIcon icon={Add01Icon} aria-hidden />
        </Button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
        {width > 0 &&
          Array.from({ length: Math.min(pdf.numPages, maxPreviewPages) }, (_, index) => (
            <PdfPage
              key={index + 1}
              pdf={pdf}
              number={index + 1}
              width={width}
              zoom={zoom}
              ratio={ratio}
              scroller={scroller}
              onCurrent={setCurrent}
            />
          ))}
        {pdf.numPages > maxPreviewPages && (
          <p className="pb-2 text-center text-xs text-muted-foreground">
            Showing the first {maxPreviewPages} pages. Download the file to read the rest.
          </p>
        )}
      </div>
    </>
  );
}

type MarkdownView = "raw" | "preview";

const markdownViews = [
  { value: "raw", label: "Raw", icon: SourceCodeIcon },
  { value: "preview", label: "Preview", icon: ViewIcon },
] as const;

/** Show Markdown as its source or rendered, switched by icon buttons. */
function MarkdownViewer({ bytes }: { readonly bytes: ArrayBuffer }) {
  const [view, setView] = useState<MarkdownView>("preview");
  const source = useMemo(() => new TextDecoder("utf-8").decode(bytes), [bytes]);
  return (
    <>
      <div className="flex items-center justify-end border-b px-4 py-2">
        <ViewSwitch label="Markdown view" options={markdownViews} value={view} onChange={setView} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {view === "raw" ? (
          <pre className="font-mono text-[12px] leading-[1.6] break-words whitespace-pre-wrap">
            {source}
          </pre>
        ) : (
          <div className={markdownDocument}>
            <ToolMarkdown blockRemoteImages>{source}</ToolMarkdown>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Stops the previewed document loading anything from the network: only inline styles and data or
 * blob media. It is the first thing in the document, which the HTML parser keeps in the head.
 */
const htmlPreviewPolicy =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; ` +
  `style-src 'unsafe-inline'; font-src data:; media-src data:">`;

const leadingDoctype = /^\s*<!doctype[^>]*>/i;

/** Put the policy first, but after a doctype, which would otherwise be ignored and force quirks mode. */
const withHtmlPreviewPolicy = (source: string) => {
  const doctype = leadingDoctype.exec(source)?.[0] ?? "";
  return doctype + htmlPreviewPolicy + source.slice(doctype.length);
};

/**
 * Show an HTML file as its source or as a page. The page is a sandboxed frame with no scripts,
 * forms, popups or origin, and no network access, on a white canvas as pages expect.
 */
function HtmlViewer({ bytes }: { readonly bytes: ArrayBuffer }) {
  const [view, setView] = useState<MarkdownView>("preview");
  const source = useMemo(() => new TextDecoder("utf-8").decode(bytes), [bytes]);
  return (
    <>
      <div className="flex items-center justify-end border-b px-4 py-2">
        <ViewSwitch label="HTML view" options={markdownViews} value={view} onChange={setView} />
      </div>
      {view === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <pre className="font-mono text-[12px] leading-[1.6] break-words whitespace-pre-wrap">
            {source}
          </pre>
        </div>
      ) : (
        <iframe
          title="HTML file preview"
          sandbox=""
          referrerPolicy="no-referrer"
          srcDoc={withHtmlPreviewPolicy(source)}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      )}
    </>
  );
}

const unplayable = "This file can't be played in this browser.";

/**
 * Play media straight from its signed link with the browser's own element, which streams with
 * range requests. If the link fails, for instance because it expired, one fresh link resumes from
 * the current time; a second failure is reported. Closing the drawer stops the transfer.
 */
function MediaPlayer({
  kind,
  mintLink,
  onDownload,
}: {
  readonly kind: "video" | "audio";
  readonly mintLink: (expiresInSeconds: number) => Promise<string>;
  readonly onDownload: () => void;
}) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const retried = useRef(false);
  const resume = useRef<{ readonly time: number; readonly playing: boolean }>(undefined);
  const [url, setUrl] = useState<string>();
  const [failure, setFailure] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    mintLink(mediaLinkSeconds).then(
      (link) => {
        if (!cancelled) setUrl(link);
      },
      (cause) => {
        if (!cancelled)
          setFailure(cause instanceof Error ? cause.message : "Could not create a link.");
      },
    );
    const element = media.current;
    return () => {
      cancelled = true;
      if (element === null) return;
      // Stops the browser fetching bytes for a file nobody is watching.
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
    // The link is minted once per opened file; the caller's closure may change every render.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onError = () => {
    const element = media.current;
    if (url === undefined || element === null) return;
    if (retried.current) return setFailure(unplayable);
    retried.current = true;
    resume.current = { time: element.currentTime, playing: !element.paused };
    mintLink(mediaLinkSeconds).then(setUrl, () => setFailure(unplayable));
  };
  const onLoadedMetadata = () => {
    const element = media.current;
    const saved = resume.current;
    if (element === null || saved === undefined) return;
    resume.current = undefined;
    element.currentTime = saved.time;
    // A browser may refuse to resume without a gesture; the controls are still there.
    if (saved.playing) element.play().catch(() => undefined);
  };

  if (failure !== undefined)
    return (
      <Notice>
        <span>
          {failure}{" "}
          {failure === unplayable && (
            <button type="button" className="underline" onClick={onDownload}>
              Download it to open it.
            </button>
          )}
        </span>
      </Notice>
    );
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {url === undefined && (
        <Notice>
          <Spinner /> <span className="ml-2">Loading preview…</span>
        </Notice>
      )}
      {kind === "video" ? (
        <video
          ref={media}
          src={url}
          controls
          preload="metadata"
          playsInline
          onError={onError}
          onLoadedMetadata={onLoadedMetadata}
          className={`max-h-[70vh] w-full bg-black object-contain ${url === undefined ? "hidden" : ""}`}
        />
      ) : (
        <div className={`p-4 ${url === undefined ? "hidden" : ""}`}>
          <audio
            ref={media}
            src={url}
            controls
            preload="metadata"
            onError={onError}
            onLoadedMetadata={onLoadedMetadata}
            className="w-full"
          />
        </div>
      )}
    </div>
  );
}

/** Bytes are fetched only for a previewable file within its size limit. */
function PreviewBody({
  file,
  kind,
  mintLink,
}: {
  readonly file: PreviewFile;
  readonly kind: BufferedKind;
  readonly mintLink: () => Promise<string>;
}) {
  const limit = limitOf(kind);
  const state = useFileBytes(file, limit, isCutAtLimit(kind), mintLink);
  if (state.status === "loading")
    return (
      <Notice>
        <Spinner /> <span className="ml-2">Loading preview…</span>
      </Notice>
    );
  if (state.status === "error") return <Notice>{state.message}</Notice>;
  if (kind === "pdf") {
    return startsWithPdfHeader(state.bytes) ? (
      <PdfViewer bytes={state.bytes} />
    ) : (
      <Notice>This file is not a valid PDF, so it cannot be previewed.</Notice>
    );
  }
  if (kind === "markdown") return <MarkdownViewer bytes={state.bytes} />;
  if (kind === "html") return <HtmlViewer bytes={state.bytes} />;
  return (
    <Suspense fallback={loadingPreview}>
      <ExtraPreview
        kind={kind}
        bytes={state.bytes}
        contentType={file.contentType}
        truncation={
          state.truncated
            ? `Showing the first ${megabytes(limit)} of ${formatBytes(file.size)}. Download the file to see all of it.`
            : undefined
        }
      />
    </Suspense>
  );
}

/**
 * A right-hand drawer previewing a PDF, Markdown, HTML, text, CSV, spreadsheet, image, video or audio file. It fetches through a short-lived link
 * the caller mints and never navigates to the link. An HTML file is rendered only in a fully
 * sandboxed frame (no scripts, forms, popups or origin) whose policy blocks every network load.
 */
export function FilePreviewSheet({
  file,
  onClose,
  mintLink,
  onDownload,
  resourceUri,
}: {
  readonly file: PreviewFile | null;
  /** The address an MCP client reads a file from, or undefined while it is not known. */
  readonly resourceUri: (file: PreviewFile) => string | undefined;
  readonly onClose: () => void;
  /** Mint a fresh download link for the file and return its URL; reject with a readable message. */
  readonly mintLink: (file: PreviewFile, expiresInSeconds?: number) => Promise<string>;
  readonly onDownload: (file: PreviewFile) => void;
}) {
  // The last file stays rendered while the drawer slides out, then the content unmounts, which
  // aborts any fetch and destroys the PDF document.
  const [last, setLast] = useState<PreviewFile | null>(file);
  if (file !== null && file !== last) setLast(file);
  const shown = file ?? last;
  return (
    <Sheet open={file !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        aria-describedby="file-preview-description"
        resizable
        storageKey="executor.files.previewWidth"
      >
        {shown !== null && (
          <FilePreviewContent
            file={shown}
            mintLink={mintLink}
            onDownload={onDownload}
            uri={resourceUri(shown)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function FilePreviewContent({
  file,
  mintLink,
  onDownload,
  uri,
}: {
  readonly file: PreviewFile;
  readonly uri: string | undefined;
  readonly mintLink: (file: PreviewFile, expiresInSeconds?: number) => Promise<string>;
  readonly onDownload: (file: PreviewFile) => void;
}) {
  const kind = previewKind(file.contentType);
  const buffered = isBuffered(kind) ? kind : undefined;
  const tooLarge =
    buffered !== undefined && !isCutAtLimit(buffered) && file.size > limitOf(buffered);
  return (
    <>
      <SheetHeader>
        <SheetTitle className="font-mono text-[13px]">{file.id.slice(0, 8)}</SheetTitle>
        <SheetDescription id="file-preview-description">
          {file.contentType} · {file.size.toLocaleString("en-US")} bytes
        </SheetDescription>
        {uri !== undefined && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 items-center gap-2 pt-2">
                  <span className="shrink-0 text-xs text-muted-foreground">Executor URI</span>
                  <code className="min-w-0 flex-1 truncate font-mono text-[11px]" title={uri}>
                    {uri}
                  </code>
                  <CopyButton code={uri} label="Copy Executor URI" />
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                An MCP client connected to Executor can read this file with resources/read. Scoped
                connections cannot read files.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <div className="pt-2">
          <Button variant="outline" size="sm" onClick={() => onDownload(file)}>
            <HugeiconsIcon icon={Download01Icon} size={15} aria-hidden />
            Download
          </Button>
        </div>
      </SheetHeader>
      {kind === undefined ? (
        <Notice>This file type cannot be previewed. Download it to open it.</Notice>
      ) : kind === "video" || kind === "audio" ? (
        <MediaPlayer
          key={file.id}
          kind={kind}
          mintLink={(seconds) => mintLink(file, seconds)}
          onDownload={() => onDownload(file)}
        />
      ) : kind === "image" ? (
        <Suspense fallback={loadingPreview}>
          <ExtraPreview
            key={file.id}
            kind="image"
            mintLink={() => mintLink(file, mediaLinkSeconds)}
          />
        </Suspense>
      ) : buffered === undefined ? null : tooLarge ? (
        <Notice>
          Too large to preview (limit {megabytes(limitOf(buffered))}). Download it to open it.
        </Notice>
      ) : (
        <PreviewBody key={file.id} file={file} kind={buffered} mintLink={() => mintLink(file)} />
      )}
    </>
  );
}
