/** The address an MCP client reads a stored file from: `executor-file://<organization id>/<handle id>`. */
export const fileResourceScheme = "executor-file://";

export const fileResourceUri = (organization: string, id: string) =>
  `${fileResourceScheme}${encodeURIComponent(organization)}/${encodeURIComponent(id)}`;
