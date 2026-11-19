# Files

A result with a `resource_link` is a file. Read it with `resources/read` if your
client supports that, else open the signed link a too-large read names or run
`executor files get <id>`. Never ask a tool for file bytes in its result.

To give a tool a file, upload it with `tools.executor.files.uploadUrl` and an HTTP PUT
of the bytes (or `executor files put`), then pass the returned handle. Never inline
large content: an approval request is capped at 100,000 bytes.
