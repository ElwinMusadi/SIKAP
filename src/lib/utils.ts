import { createCn } from "cn/config"

/**
 * Class merging aware of the design-system tokens in src/index.css. Without this, tailwind-merge
 * treats `text-eyebrow`/`text-h3` as text colours and `shadow-card` as a shadow colour, and drops them
 * when combined with e.g. `text-muted-foreground`. Always import `cn` from here, never from the "cn"
 * package directly (new shadcn components do that by default: fix the import after `shadcn add`).
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["display", "h2", "h3", "eyebrow", "metric"] }],
      shadow: [{ shadow: ["card", "pop", "dialog"] }],
    },
  },
})
