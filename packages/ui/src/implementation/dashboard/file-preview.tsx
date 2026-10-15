"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { ToolMarkdown } from "./markdown.tsx";
import { markdownDocument } from "./markdown-prose.ts";

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

/** Media streams from its link, so nothing is buffered by the page and no size cap applies. */
export type PreviewKind = "pdf" | "markdown" | "video" | "audio";
type BufferedKind = "pdf" | "markdown";

/** A media link outlives a long playback: four hours, where the default is fifteen minutes. */
export const mediaLinkSeconds = 4 * 60 * 60;

/** The previewable kind of a stored content type, or undefined. Files carry no name, so no extension. */
export const previewKind = (contentType: string): PreviewKind | undefined => {
  const type = contentType.split(";")[0]?.trim().toLowerCase();
  if (type === "application/pdf" || type === "application/x-pdf") return "pdf";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
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

const limitOf = (kind: BufferedKind) =>
  kind === "pdf" ? maxPdfPreviewBytes : maxMarkdownPreviewBytes;

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MiB`;

type Bytes =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly bytes: ArrayBuffer }
  | { readonly status: "error"; readonly message: string };

/**
 * Read a response body, stopping as soon as it passes `limit` bytes so the cap bounds the memory
 * used, not just the final size. Returns undefined when the body is larger than the limit.
 */
async function readWithin(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<ArrayBuffer | undefined> {
  if (response.body === null) {
    const whole = await response.arrayBuffer();
    return whole.byteLength > limit ? undefined : whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return undefined;
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
  return joined.buffer;
}

/**
 * Fetch a file's bytes through a freshly minted link. The request is aborted and the bytes
 * dropped when the drawer closes; nothing is cached across openings.
 */
function useFileBytes(file: PreviewFile, limit: number, mintLink: () => Promise<string>): Bytes {
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
        if (Number.isFinite(declared) && declared > limit) {
          controller.abort();
          return setState({ status: "error", message: "Too large to preview." });
        }
        const bytes = await readWithin(response, limit, controller.signal);
        if (bytes === undefined) {
          controller.abort();
          return setState({ status: "error", message: "Too large to preview." });
        }
        if (!controller.signal.aborted) setState({ status: "ready", bytes });
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
  }, [file.id, limit]);
  return state;
}

const startsWithPdfHeader = (bytes: ArrayBuffer) => {
  const head = new Uint8Array(bytes, 0, Math.min(5, bytes.byteLength));
  return head.length === 5 && String.fromCharCode(...head) === "%PDF-";
};

/** A message filling the drawer body. */
function Notice({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      role="status"
      className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

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
  // A radiogroup is one tab stop; the arrow keys move the choice, as a native radio group does.
  const onViewKey = (event: React.KeyboardEvent<HTMLButtonElement>, current: MarkdownView) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const index = markdownViews.findIndex((option) => option.value === current);
    const next = markdownViews[(index + step + markdownViews.length) % markdownViews.length]!;
    setView(next.value);
    const buttons = event.currentTarget.parentElement?.parentElement?.querySelectorAll("button");
    (buttons?.[markdownViews.indexOf(next)] as HTMLButtonElement | undefined)?.focus();
  };
  return (
    <>
      <div className="flex items-center justify-end border-b px-4 py-2">
        <TooltipProvider>
          <div
            role="radiogroup"
            aria-label="Markdown view"
            className="flex shrink-0 rounded-md border p-0.5"
          >
            {markdownViews.map((option) => (
              <Tooltip key={option.value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={view === option.value}
                    tabIndex={view === option.value ? 0 : -1}
                    onKeyDown={(event) => onViewKey(event, option.value)}
                    aria-label={option.label}
                    onClick={() => setView(option.value)}
                    className={`rounded px-2 py-1 transition-colors ${
                      view === option.value
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <HugeiconsIcon icon={option.icon} size={16} aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{option.label}</TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
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
  const state = useFileBytes(file, limitOf(kind), mintLink);
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
  return <MarkdownViewer bytes={state.bytes} />;
}

/**
 * A right-hand drawer previewing a PDF, Markdown, video or audio file. It fetches through a short-lived link
 * the caller mints, never navigates to the link and never renders HTML from the file.
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
      <SheetContent aria-describedby="file-preview-description">
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
  const buffered = kind === "pdf" || kind === "markdown" ? kind : undefined;
  const tooLarge = buffered !== undefined && file.size > limitOf(buffered);
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
