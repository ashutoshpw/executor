---
"@executor-js/sdk": patch
"apps": patch
---

The self-host product serves the `apps` framework it was built with. An app that
declares exactly this checkout's version (now `0.0.1-beta.92-fork.1`, which no
npm release can share) builds from the host's own files, so it speaks the
host's protocol instead of the one npm holds for a lookalike version. Apps
pinned to a published release still install it from the registry. Set
`EXECUTOR_APPS_FRAMEWORK_DISABLED=true` to install every release from the
registry. Outside the image, `EXECUTOR_APPS_FRAMEWORK_DIR` names another built
`apps` package.
