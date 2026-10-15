import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit, Option, Predicate } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Download01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { fileResourceUri } from "@executor-js/mcp/browser";
import type { AppId } from "@executor-js/sdk/core";
import { Alert, AlertDescription } from "@executor-js/ui/components/alert";
import { Button } from "@executor-js/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@executor-js/ui/components/dialog";
import { LocalTime } from "@executor-js/ui/components/local-time";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@executor-js/ui/components/select";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { FilePreviewSheet } from "@executor-js/ui/dashboard/file-preview";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import type { FileEntry } from "@executor-js/hosted-server/files";
import { deleteFileAtom, downloadLinkAtom, fileAtom, filesAtom } from "../../contracts/files.ts";
import { type HostedError } from "../../contracts/errors.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { appError } from "../../contracts/errors.ts";
import { FilesFrame, FilesLoading, filesTitle } from "../components/page-pending.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

const allApps = "all";

const filesTableClass =
  "w-full text-left text-[13px] [border-collapse:collapse] [&_th]:h-10.5 [&_th]:px-4 [&_th]:py-[7px] [&_th]:text-[12px] [&_th]:font-normal [&_th]:text-muted-foreground [&_td]:h-15 [&_td]:px-4 [&_td]:py-[10px] [&_td]:align-middle [&_tbody_tr_+_tr]:border-t [&_tbody_tr_+_tr]:border-t-border max-[800px]:[&_.files-created]:hidden max-[800px]:[&_.files-expires]:hidden";

const units = ["B", "KB", "MB", "GB"] as const;
/** A size in bytes the way file managers print it, with one decimal above a kilobyte. */
export const formatFileSize = (bytes: number) => {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
};

/** Files the organization's apps keep, as the signed-in member may see them. */
export function FilesPage({
  app,
  file,
  onAppChange,
  onFileChange,
}: {
  /** The app the listing is filtered to, from the address. */
  readonly app: AppId | undefined;
  /** The handle of the file open in the drawer, from the address. */
  readonly file: string | undefined;
  readonly onAppChange: (app: AppId | undefined) => void;
  readonly onFileChange: (file: string | undefined) => void;
}) {
  const { organization, slug } = useOrganizationRoute();
  const [generation, setGeneration] = useState(0);
  // The cursors of the pages shown so far; the first page has none.
  const [afters, setAfters] = useState<ReadonlyArray<string | undefined>>([undefined]);
  const first = useAtomValue(filesAtom({ organization, app, after: undefined, generation }));
  useDocumentTitle(productTitle(filesTitle));
  const page = AsyncResult.value(first);
  const reset = () => {
    setGeneration((current) => current + 1);
    setAfters([undefined]);
  };
  if (Option.isNone(page))
    return (
      <FilesFrame>
        {AsyncResult.isFailure(first) ? (
          <HostedFailure cause={first.cause} retry={reset} />
        ) : (
          <FilesLoading />
        )}
      </FilesFrame>
    );
  const { apps, canDelete } = page.value;
  return (
    <FilesFrame>
      {apps.length > 0 && (
        <div className="mb-4 flex">
          <Select
            value={app ?? allApps}
            onValueChange={(value) => {
              onAppChange(apps.find((choice) => choice.id === value)?.id);
              setGeneration((current) => current + 1);
              setAfters([undefined]);
            }}
          >
            <SelectTrigger aria-label="Filter by app" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allApps}>All apps</SelectItem>
              {apps.map((choice) => (
                <SelectItem key={choice.id} value={choice.id}>
                  {choice.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <FilesTable
        pages={afters.map((after) => ({ after }))}
        canDelete={canDelete}
        app={app}
        file={file}
        onFileChange={onFileChange}
        generation={generation}
        more={(next) => setAfters((current) => [...current, next])}
        changed={reset}
        filtered={app !== undefined}
      />
      <p className="mt-4 text-[13px] text-muted-foreground">
        Files expire after the lifetime set in{" "}
        <Link
          to="/org/$organizationSlug/organization"
          params={{ organizationSlug: slug }}
          search={{ tab: "files" }}
          className="underline underline-offset-2"
        >
          organization settings
        </Link>
        .
      </p>
    </FilesFrame>
  );
}

function FilesTable({
  pages,
  canDelete,
  app,
  file,
  onFileChange,
  generation,
  more,
  changed,
  filtered,
}: {
  readonly pages: ReadonlyArray<{ readonly after: string | undefined }>;
  readonly canDelete: boolean;
  readonly app: AppId | undefined;
  readonly file: string | undefined;
  readonly onFileChange: (file: string | undefined) => void;
  readonly generation: number;
  readonly more: (next: string) => void;
  readonly changed: () => void;
  readonly filtered: boolean;
}) {
  const { organization, id: organizationId } = useOrganizationRoute();
  const [removing, setRemoving] = useState<FileEntry | null>(null);
  const [failure, setFailure] = useState<Cause.Cause<HostedError>>();
  const remove = useAtomSet(deleteFileAtom(organization), { mode: "promiseExit" });
  const deletion = useAtomValue(deleteFileAtom(organization));
  const link = useAtomSet(downloadLinkAtom(organization), { mode: "promiseExit" });
  const [downloadFailure, setDownloadFailure] = useState<Cause.Cause<HostedError>>();
  const firstPage = useAtomValue(filesAtom({ organization, app, after: undefined, generation }));
  const empty = AsyncResult.value(firstPage).pipe(
    Option.map((value) => value.files.length === 0),
    Option.getOrElse(() => false),
  );
  const download = async (entry: FileEntry) => {
    setDownloadFailure(undefined);
    const result = await link({ handle: entry.id });
    if (Exit.isFailure(result)) {
      // Close the drawer so the failure is not rendered behind its modal overlay.
      onFileChange(undefined);
      setDownloadFailure(result.cause);
    } else window.location.assign(result.value.url);
  };
  const preview = file !== undefined && (
    <LinkedPreview
      handle={file}
      resourceUri={(entry) =>
        organizationId === undefined ? undefined : fileResourceUri(organizationId, entry.id)
      }
      onClose={() => onFileChange(undefined)}
      onDownload={(entry) => void download(entry)}
      mintLink={async (entry, expiresInSeconds) => {
        const result = await link(
          expiresInSeconds === undefined
            ? { handle: entry.id }
            : { handle: entry.id, expiresInSeconds },
        );
        if (Exit.isFailure(result)) throw new Error(appError(result.cause));
        return result.value.url;
      }}
    />
  );
  if (empty)
    return (
      <>
        {preview}
        <EmptyState
          title={filtered ? "No files for this app" : "No files yet"}
          icon={<HugeiconsIcon icon={File01Icon} />}
        >
          Files an app stores for your organization appear here until they expire.
        </EmptyState>
      </>
    );
  return (
    <>
      {downloadFailure && <HostedFailure cause={downloadFailure} />}
      {preview}
      <div className="overflow-hidden rounded-[10px] border border-border bg-background">
        <table className={filesTableClass} aria-label="Files">
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">App</th>
              <th scope="col" className="files-created">
                Created
              </th>
              <th scope="col" className="files-expires">
                Expires
              </th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          {pages.map((page, index) => (
            <FilesChunk
              key={page.after ?? "first"}
              after={page.after}
              app={app}
              generation={generation}
              last={index === pages.length - 1}
              more={more}
              canDelete={canDelete}
              download={download}
              preview={(entry) => onFileChange(entry.id)}
              remove={setRemoving}
            />
          ))}
        </table>
      </div>
      {removing && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open && !deletion.waiting) setRemoving(null);
          }}
        >
          <DialogContent>
            <DialogTitle>Delete this file?</DialogTitle>
            <DialogDescription>
              Apps can no longer read {removing.id}, and links to it stop working. This cannot be
              undone.
            </DialogDescription>
            {failure && <HostedFailure cause={failure} />}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={deletion.waiting}
                onClick={() => setRemoving(null)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                loading={deletion.waiting}
                onClick={async () => {
                  setFailure(undefined);
                  const result = await remove(removing.id);
                  if (Exit.isFailure(result)) setFailure(result.cause);
                  else {
                    if (file === removing.id) onFileChange(undefined);
                    setRemoving(null);
                    changed();
                  }
                }}
              >
                Delete file
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/**
 * The drawer for the file the address names. The file is read by handle, because it may not be on
 * a page the listing has loaded; one the caller cannot reach gets a notice instead of a drawer.
 */
function LinkedPreview({
  handle,
  onClose,
  ...sheet
}: {
  readonly handle: string;
  readonly onClose: () => void;
  readonly resourceUri: (file: { readonly id: string }) => string | undefined;
  readonly onDownload: (file: FileEntry) => void;
  readonly mintLink: (file: FileEntry, expiresInSeconds?: number) => Promise<string>;
}) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(fileAtom({ organization, handle }));
  const retry = useAtomRefresh(fileAtom({ organization, handle }));
  const entry = Option.getOrNull(AsyncResult.value(result));
  if (AsyncResult.isFailure(result) && entry === null) {
    const error = Cause.findErrorOption(result.cause);
    // Only a file the server says is absent gets the notice. A network error, a server error or
    // unavailable storage says nothing about the file, so it can be retried.
    if (
      !(
        Option.isSome(error) &&
        Predicate.hasProperty(error.value, "_tag") &&
        error.value._tag === "FileNotFound"
      )
    )
      return (
        <div className="mb-4">
          <HostedFailure cause={result.cause} retry={retry} />
        </div>
      );
    return (
      <Alert className="mb-4">
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>This file is no longer available or you don't have access to it.</span>
          <Button variant="outline" size="sm" onClick={onClose}>
            Dismiss
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <FilePreviewSheet
      file={entry}
      resourceUri={sheet.resourceUri}
      onClose={onClose}
      onDownload={(file) => sheet.onDownload(file as FileEntry)}
      mintLink={(file, expiresInSeconds) => sheet.mintLink(file as FileEntry, expiresInSeconds)}
    />
  );
}

/** One page of rows. The last page offers the next one. */
function FilesChunk({
  after,
  app,
  generation,
  last,
  more,
  canDelete,
  download,
  preview,
  remove,
}: {
  readonly after: string | undefined;
  readonly app: AppId | undefined;
  readonly generation: number;
  readonly last: boolean;
  readonly more: (next: string) => void;
  readonly canDelete: boolean;
  readonly download: (file: FileEntry) => Promise<void>;
  readonly preview: (file: FileEntry) => void;
  readonly remove: (file: FileEntry) => void;
}) {
  const { organization } = useOrganizationRoute();
  const result = useAtomValue(filesAtom({ organization, app, after, generation }));
  const page = AsyncResult.value(result);
  if (Option.isNone(page))
    return (
      <tbody>
        <tr>
          <td colSpan={6}>
            {AsyncResult.isFailure(result) ? (
              <HostedFailure cause={result.cause} />
            ) : (
              <span role="status" className="text-muted-foreground">
                Loading files…
              </span>
            )}
          </td>
        </tr>
      </tbody>
    );
  const { files, next } = page.value;
  return (
    <tbody>
      {files.map((file) => (
        <tr key={file.id}>
          <td>
            <button
              type="button"
              className="font-mono text-[12px] underline-offset-2 hover:underline focus-visible:underline"
              aria-label={`Preview ${file.id}`}
              onClick={() => preview(file)}
            >
              {file.id.slice(0, 8)}
            </button>
            <div className="text-muted-foreground">{file.contentType}</div>
          </td>
          <td>{formatFileSize(file.size)}</td>
          <td>
            {file.app === null ? (
              <span className="text-muted-foreground">Uploaded over API</span>
            ) : (
              (file.app.name ?? <span className="text-muted-foreground">Deleted app</span>)
            )}
          </td>
          <td className="files-created">
            <LocalTime value={file.createdAt} />
          </td>
          <td className="files-expires">
            <LocalTime value={file.expiresAt} />
          </td>
          <td className="whitespace-nowrap text-right">
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Download ${file.id}`}
              onClick={() => void download(file)}
            >
              <HugeiconsIcon icon={Download01Icon} size={15} />
            </Button>
            {canDelete && (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Delete ${file.id}`}
                onClick={() => remove(file)}
              >
                <HugeiconsIcon icon={Delete02Icon} size={15} />
              </Button>
            )}
          </td>
        </tr>
      ))}
      {last && next !== null && (
        <tr>
          <td colSpan={6} className="text-center">
            <Button variant="outline" size="sm" onClick={() => more(next)}>
              Load more
            </Button>
          </td>
        </tr>
      )}
    </tbody>
  );
}
