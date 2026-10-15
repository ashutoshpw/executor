import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit, Option, type Cause } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, Download01Icon, File01Icon } from "@hugeicons/core-free-icons";
import { fileResourceUri } from "@executor-js/mcp/browser";
import type { AppId } from "@executor-js/sdk/core";
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
import { deleteFileAtom, downloadLinkAtom, filesAtom } from "../../contracts/files.ts";
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
export function FilesPage() {
  const { organization, slug } = useOrganizationRoute();
  const [app, setApp] = useState<AppId | undefined>(undefined);
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
              setApp(apps.find((choice) => choice.id === value)?.id);
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
  generation,
  more,
  changed,
  filtered,
}: {
  readonly pages: ReadonlyArray<{ readonly after: string | undefined }>;
  readonly canDelete: boolean;
  readonly app: AppId | undefined;
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
  const [previewing, setPreviewing] = useState<FileEntry | null>(null);
  const [downloadFailure, setDownloadFailure] = useState<Cause.Cause<HostedError>>();
  const firstPage = useAtomValue(filesAtom({ organization, app, after: undefined, generation }));
  const empty = AsyncResult.value(firstPage).pipe(
    Option.map((value) => value.files.length === 0),
    Option.getOrElse(() => false),
  );
  if (empty)
    return (
      <EmptyState
        title={filtered ? "No files for this app" : "No files yet"}
        icon={<HugeiconsIcon icon={File01Icon} />}
      >
        Files an app stores for your organization appear here until they expire.
      </EmptyState>
    );
  const download = async (file: FileEntry) => {
    setDownloadFailure(undefined);
    const result = await link({ handle: file.id });
    if (Exit.isFailure(result)) {
      // Close the drawer so the failure is not rendered behind its modal overlay.
      setPreviewing(null);
      setDownloadFailure(result.cause);
    } else window.location.assign(result.value.url);
  };
  return (
    <>
      {downloadFailure && <HostedFailure cause={downloadFailure} />}
      <FilePreviewSheet
        file={previewing}
        resourceUri={(file) =>
          organizationId === undefined ? undefined : fileResourceUri(organizationId, file.id)
        }
        onClose={() => setPreviewing(null)}
        onDownload={(file) => void download(file as FileEntry)}
        mintLink={async (file, expiresInSeconds) => {
          const result = await link(
            expiresInSeconds === undefined
              ? { handle: file.id }
              : { handle: file.id, expiresInSeconds },
          );
          if (Exit.isFailure(result)) throw new Error(appError(result.cause));
          return result.value.url;
        }}
      />
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
              preview={setPreviewing}
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
