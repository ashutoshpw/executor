---
name: executor
description: Start here. What Executor is, how to find and call app tools with search, call and execute, when to build an app, and when to send feedback.
---

# Executor

## What Executor is

Executor is a host that runs apps: TypeScript packages that expose tools,
storage, UI, accounts and background work. Agents reach every app through the
MCP tools `skills`, `search`, `describe`, `call` and `execute`, with each app's
slug as its namespace. Credentials go only through Executor's secure connection
links, never through chat or source code. Some calls pause for user approval.

This is the Executor app's `executor` skill. Read its other skills with
`skills({app: "executor", name: "code-mode"})`; `skills({})` lists them all.

## Find and call tools

`search({ query: "..." })` returns each tool's exact `path`, such as
`tools.<slug>.<tool>`, and input type; `describe({ paths })` returns full
signatures. Never guess argument names.

For a few independent calls, use `call({ calls: { path, input } })`; an array
of calls runs concurrently. Each result has `ok` and its `value` or `error`.

Write a JavaScript program for `execute` when one call's result feeds another,
or a large result should be filtered before it reaches you. Inside it, the same
paths are async functions, and `tools.search` and `tools.search.describe` work
as above. Return only the data you need. For depth, read the `code-mode` skill.
When `call` or `execute` pauses for approval or input, show the request to the
user and resume it; never repeat the call or run the program again.

A result with a `resource_link` is a file. Read it with `resources/read` if your
client supports that, else open the signed link a too-large read names or run
`executor files get <id>`. Never ask a tool for file bytes in its result.

To give a tool a file, upload it with `tools.executor.files.uploadUrl` and an HTTP PUT
of the bytes (or `executor files put`), then pass the returned handle. Never inline
large content: an approval request is capped at 100,000 bytes.

## Build an app

Build an app when no existing app provides the tools, data, UI or automation
the user needs. For a known service, search the catalog first:
`organization.catalog({ query: { search: "gmail", limit: "20" } })`, then
`apps.install` a match or `apps.importCustom` a remote MCP URL. The dashboard
shows the same catalog at `/org/<slug>/apps/add`. With a shell, use the
`executor apps` CLI, else `execute`; read the `app-authoring` skill first.

## Dashboard links

Every dashboard page is under `/org/<slug>`, such as `/org/<slug>/apps/<appId>`;
bare `/apps/<id>` does not exist. Prefer a URL a tool returned. The page table
is in the docs, Organizations and access, "Dashboard URLs".

## Send feedback

Send feedback with the Executor app's `feedback.submit` tool when Executor gets
in your way, can't do something you need, works especially well, or the user
has feedback. Before your final reply, check whether anything is worth
reporting. Be specific; never include credentials or user data (`feedback.md`).
