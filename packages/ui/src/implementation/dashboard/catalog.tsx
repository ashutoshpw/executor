import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useContext, useState, type ComponentType, type ReactNode } from "react";
import { Cause, Effect, Exit, Option, Predicate } from "effect";
import type { App, DeployedApp, Publication } from "@executor-js/sdk";
import type { CatalogEntry } from "@executor-js/catalog/contracts";
import type {
  QueryProps,
  MutationProps,
  FailureProps,
  InstallApp,
  Inventory,
  Query,
} from "../../contracts/dashboard.ts";
import type { AppAcknowledgement } from "../../contracts/app-management.ts";
import { Empty, ProviderIcon, SearchInput } from "./common.tsx";
import { CatalogCountSkeleton, CatalogPageFrame, CatalogRowsSkeleton } from "./loading.tsx";
import { Button } from "../components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "../components/dialog.tsx";
import { Input } from "../components/input.tsx";
import { useIncrementalList } from "./incremental-list.tsx";

/**
 * The installed copy of each catalog package, by package name. Installs record the catalog package
 * as their copy origin, so the most recent copy of a package is the one a catalog row leads to.
 */
export function installedCatalogApps(apps: readonly App[] | undefined): ReadonlyMap<string, App> {
  const installed = new Map<string, App>();
  for (const app of apps ?? []) {
    const name = app.copiedFrom?.name;
    const latest = name === undefined ? undefined : installed.get(name);
    if (name !== undefined && (!latest || app.createdAt > latest.createdAt))
      installed.set(name, app);
  }
  return installed;
}

/** Runs one command with its input and resolves with that row's own result. */
function useRunCommand<IE>() {
  const registry = useContext(RegistryContext);
  return async <I, A>(command: MutationProps<I, A, IE>["mutation"], input: I) => {
    const release = registry.mount(command);
    try {
      registry.set(command, input);
      return await Effect.runPromiseExit(
        AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }),
      );
    } finally {
      release();
    }
  };
}

/** Runs one catalog entry's install and resolves with that entry's own result. */
export function useCatalogInstall<IE>(
  mutation: (entry: string) => MutationProps<InstallApp, DeployedApp, IE>["mutation"],
) {
  const run = useRunCommand<IE>();
  return (entry: CatalogEntry, input: InstallApp) => run(mutation(entry.id), input);
}

/** A public listing's copy input: the name for the new app, and how the host acknowledges it. */
type PublicCopyInput = { readonly name: string; readonly onApp: AppAcknowledgement };

/** One row is an official catalog app or a public listing; both add the same way. */
type Row =
  | { readonly kind: "official"; readonly entry: CatalogEntry }
  | { readonly kind: "public"; readonly publication: Publication };

const rowKey = (row: Row) =>
  row.kind === "official" ? row.entry.id : `public:${row.publication.name}`;
/** The package an installed copy records as its origin, which Open follows. */
const rowPackage = (row: Row) =>
  row.kind === "official" ? row.entry.package : row.publication.name;
const rowTitle = (row: Row) => (row.kind === "official" ? row.entry.name : row.publication.name);
/** A public copy takes the package's own name, without its scope. */
const defaultName = (row: Row) =>
  row.kind === "official"
    ? row.entry.name
    : row.publication.name.slice(row.publication.name.indexOf("/") + 1);

/**
 * Public listings first, then official apps in the feed's order. Each row installs its own source
 * under its default name. Official apps are vetted, and public listings are copied from their
 * reviewed commit. Only a name conflict asks for another one. The page stays put after an add; a
 * row whose app is installed, now or in an earlier visit, offers Open instead of Add. Installs record
 * their package as their copy origin, so the most recent copy of that package is the one Open leads
 * to. The user then connects an account through the app's own providers. A failed public-listing read
 * leaves the official apps listed.
 */
export function CatalogPage<E, IE, P>({
  query,
  Failure,
  mutation,
  InstallFailure,
  back,
  action,
  create,
  inventory,
  open,
  publications,
  PublicationFailure,
  copy,
  onApp,
}: QueryProps<readonly CatalogEntry[], E> & {
  /** The install command for one catalog entry; each row has its own. */
  readonly mutation: (entry: string) => MutationProps<InstallApp, DeployedApp, IE>["mutation"];
  readonly InstallFailure: MutationProps<InstallApp, DeployedApp, IE>["Failure"];
  readonly back: ReactNode;
  /** The heading's action, beside the title. */
  readonly action?: ReactNode;
  /** Offers the ways to make an app when nothing here fits. */
  readonly create?: ReactNode;
  /** The apps already installed; a failed read just leaves every row on Add. */
  readonly inventory: Query<Inventory, unknown>;
  /** A link to the installed app, rendered inside the row's Open button. */
  readonly open: (app: App) => ReactNode;
  /** Public listings anyone can copy. */
  readonly publications: Query<ReadonlyArray<Publication>, P>;
  readonly PublicationFailure: ComponentType<FailureProps<NoInfer<P>>>;
  /** The copy command for one public listing; each row has its own. */
  readonly copy: (publication: Publication) => MutationProps<PublicCopyInput, App, IE>["mutation"];
  /** Records each copy the way the host records its other apps. */
  readonly onApp: AppAcknowledgement;
}) {
  const result = useAtomValue(query);
  const publicResult = useAtomValue(publications);
  const retryPublic = useAtomRefresh(publications);
  const installedByPackage = installedCatalogApps(
    Option.getOrUndefined(AsyncResult.value(useAtomValue(inventory)))?.apps,
  );
  const run = useRunCommand<IE>();
  const attempt = (row: Row, name: string) =>
    row.kind === "official"
      ? run(mutation(row.entry.id), { entry: row.entry.id, name })
      : run(copy(row.publication), { name, onApp });
  const [adding, setAdding] = useState<ReadonlySet<string>>(new Set());
  const [failure, setFailure] = useState<Cause.Cause<IE>>();
  const [conflict, setConflict] = useState<{
    readonly row: Row;
    readonly name: string;
    /** The name that was taken, kept while the person types another. */
    readonly taken: string;
  }>();
  /** Installs under `name`; a taken name reopens the prompt, any other failure is shown above the list. */
  const add = async (row: Row, name: string) => {
    const key = rowKey(row);
    if (adding.has(key) || !name.trim()) return;
    setAdding((current) => new Set(current).add(key));
    setFailure(undefined);
    try {
      const exit = await attempt(row, name.trim());
      if (Exit.isSuccess(exit)) {
        setConflict(undefined);
        return;
      }
      const taken = Option.filter(
        Cause.findErrorOption(exit.cause),
        Predicate.isTagged("AppNameTaken"),
      );
      setFailure(exit.cause);
      setConflict(
        Option.isSome(taken) ? { row, name: name.trim(), taken: name.trim() } : undefined,
      );
    } finally {
      setAdding((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  };
  const renaming = conflict !== undefined && adding.has(rowKey(conflict.row));
  const retry = useAtomRefresh(query);
  const [search, setSearch] = useState("");
  const templates = AsyncResult.value(result);
  const listed = AsyncResult.value(publicResult);
  const term = search.trim().toLowerCase();
  const rows: Row[] = [
    ...(Option.isSome(listed) ? listed.value : []).map((publication): Row => ({
      kind: "public",
      publication,
    })),
    ...(Option.isSome(templates) ? templates.value : []).map((entry): Row => ({
      kind: "official",
      entry,
    })),
  ];
  // Name matches come first; the rest keep their order above.
  const entries = rows
    .filter((row) =>
      (row.kind === "official"
        ? `${row.entry.name} ${row.entry.package} ${row.entry.category ?? ""} ${row.entry.description}`
        : `${row.publication.name} ${row.publication.description}`
      )
        .toLowerCase()
        .includes(term),
    )
    .sort(
      (a, b) =>
        Number(!rowTitle(a).toLowerCase().includes(term)) -
        Number(!rowTitle(b).toLowerCase().includes(term)),
    );
  const visible = useIncrementalList(entries.length, term, 50);
  return (
    <CatalogPageFrame
      back={back}
      action={action}
      toolbar={
        <>
          <SearchInput autoFocus value={search} onChange={setSearch} placeholder="Search apps…" />
          {(AsyncResult.isInitial(result) || AsyncResult.isInitial(publicResult)) &&
          !entries.length ? (
            <CatalogCountSkeleton />
          ) : (
            <span className="muted min-w-20 text-muted-foreground tabular-nums">
              {entries.length.toLocaleString("en-US")} apps
            </span>
          )}
        </>
      }
    >
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} retry={retry} />}
      {AsyncResult.isFailure(publicResult) && (
        <PublicationFailure cause={publicResult.cause} retry={retryPublic} />
      )}
      {failure && conflict === undefined && <InstallFailure cause={failure} />}
      {!entries.length && (AsyncResult.isInitial(result) || AsyncResult.isInitial(publicResult)) ? (
        <CatalogRowsSkeleton />
      ) : !entries.length &&
        (AsyncResult.isFailure(result) ||
          AsyncResult.isFailure(publicResult)) ? null : !entries.length ? (
        <Empty
          title={search ? "No matching apps" : "No apps available"}
          action={
            search ? (
              <Button variant="outline" onClick={() => setSearch("")}>
                Clear search
              </Button>
            ) : undefined
          }
        >
          {create ? <MissingApp create={create} /> : "Try another name."}
        </Empty>
      ) : (
        <>
          <div className="catalog-list border-t border-t-border">
            {entries.slice(0, visible.count).map((row) => {
              const key = rowKey(row);
              const title = rowTitle(row);
              const installed = installedByPackage.get(rowPackage(row));
              return (
                <div
                  className="catalog-row w-full flex items-center gap-4 min-h-18.5 py-[15px] px-[12px] border-b border-b-border max-[740px]:grid max-[740px]:grid-cols-[34px_minmax(0,_1fr)_auto] max-[740px]:gap-[4px_12px] max-[740px]:py-[15px] max-[740px]:px-0 max-[740px]:[&_>_[data-slot='button']]:col-[3] max-[740px]:[&_>_[data-slot='button']]:row-[1_/_3]"
                  key={key}
                >
                  <ProviderIcon
                    name={title}
                    icons={row.kind === "official" ? row.entry.icons : undefined}
                  />
                  <div className="catalog-row-title flex-1 flex flex-col gap-1.25 min-w-0 [&_strong]:text-[13px] [&_strong]:font-medium [&_span]:text-[12px] [&_span]:text-muted-foreground wrap-anywhere max-[740px]:col-[2]">
                    <strong>{title}</strong>
                    <span className="line-clamp-1">
                      {row.kind === "official"
                        ? row.entry.description
                        : row.publication.description || "Public app"}
                    </span>
                  </div>
                  {installed ? (
                    <Button variant="outline" size="sm" className="min-w-21" asChild>
                      {open(installed)}
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="min-w-21"
                      aria-label={`Add ${title}`}
                      disabled={adding.has(key)}
                      onClick={() => void add(row, defaultName(row))}
                    >
                      {adding.has(key) ? "Adding…" : "Add"}
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
          {visible.sentinel}
          {create && (
            <p className="mt-6 text-center text-[13px] text-muted-foreground">
              <MissingApp create={create} />
            </p>
          )}
        </>
      )}
      <Dialog
        open={conflict !== undefined}
        onOpenChange={(open) => {
          if (!open && !renaming) {
            setConflict(undefined);
            setFailure(undefined);
          }
        }}
      >
        <DialogContent>
          <DialogTitle>Choose another name</DialogTitle>
          <DialogDescription>
            {conflict ? `You already have an app named ${conflict.taken}.` : null}
          </DialogDescription>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (conflict) void add(conflict.row, conflict.name);
            }}
          >
            <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium">
              App name
              <Input
                autoFocus
                required
                maxLength={120}
                value={conflict?.name ?? ""}
                onChange={(event) =>
                  setConflict((current) => current && { ...current, name: event.target.value })
                }
                disabled={renaming}
              />
            </label>
            {failure && <InstallFailure cause={failure} layout="compact" />}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={renaming}
                onClick={() => {
                  setConflict(undefined);
                  setFailure(undefined);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={renaming || !conflict?.name.trim()}>
                {renaming ? "Adding…" : "Add app"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </CatalogPageFrame>
  );
}

function MissingApp({ create }: { readonly create: ReactNode }) {
  return <>Can’t find what you’re looking for? {create}</>;
}
