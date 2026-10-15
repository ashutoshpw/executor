/** Rendered Markdown typography, shared by the skill reader and editor so editing looks like reading. */
export const markdownProse =
  "text-sm leading-7 wrap-anywhere [&_h1]:mb-5 [&_h1]:mt-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:my-4 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:my-3 [&_h3]:font-medium [&_p]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-[11px] [&_pre]:leading-[1.8] [&_code]:font-mono [&_code]:text-xs [&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_table]:block [&_table]:overflow-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2";

/**
 * A full document view of Markdown, for previewing a file. Tailwind's reset flattens headings,
 * lists and rules, so each element is styled here. Code blocks are left to the shared Code
 * renderer, so only inline code is styled.
 */
export const markdownDocument = [
  "text-sm leading-7 wrap-anywhere text-foreground",
  "[&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:border-b [&_h1]:pb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:leading-tight",
  "[&_h2]:mb-3 [&_h2]:mt-7 [&_h2]:border-b [&_h2]:pb-1.5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:leading-tight",
  "[&_h3]:mb-2 [&_h3]:mt-6 [&_h3]:text-lg [&_h3]:font-semibold",
  "[&_h4]:mb-2 [&_h4]:mt-5 [&_h4]:text-base [&_h4]:font-semibold",
  "[&_h5]:mb-2 [&_h5]:mt-4 [&_h5]:text-sm [&_h5]:font-semibold",
  "[&_h6]:mb-2 [&_h6]:mt-4 [&_h6]:text-sm [&_h6]:font-semibold [&_h6]:text-muted-foreground",
  "[&_p]:my-3",
  "[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:pl-6",
  "[&_li]:my-1 [&_li>ol]:my-1 [&_li>ul]:my-1 [&_ul_ul]:list-[circle] [&_ul_ul_ul]:list-[square]",
  "[&_.contains-task-list]:list-none [&_.contains-task-list]:pl-1 [&_.task-list-item_input]:mr-2 [&_.task-list-item_input]:align-middle",
  "[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground",
  "[&_hr]:my-6 [&_hr]:border-border",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_strong]:font-semibold [&_em]:italic [&_del]:line-through",
  "[&_:not(pre)>code]:rounded [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em]",
  "[&_table]:my-4 [&_table]:block [&_table]:w-max [&_table]:max-w-full [&_table]:overflow-auto [&_table]:border-collapse",
  "[&_th]:border [&_th]:bg-muted [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:px-3 [&_td]:py-1.5",
].join(" ");
