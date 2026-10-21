import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

// SIKAP callout (docs/RENCANA-REDESIGN-UIUX.md §5): tones follow the status registry. Title takes the
// tone colour, body text stays foreground for contrast on the tinted backgrounds.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border p-3 text-left text-sm text-foreground has-data-[slot=alert-action]:relative has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /** Neutral information. */
        default: "bg-muted/40 *:[svg]:text-muted-foreground",
        /** Needs attention / waiting (amber). */
        pending:
          "border-status-pending/25 bg-status-pending-muted *:[svg]:text-status-pending *:data-[slot=alert-title]:text-status-pending *:data-[slot=alert-description]:text-foreground",
        /** Failed / rejected (red is reserved for these). */
        destructive:
          "border-status-rejected/25 bg-status-rejected-muted *:[svg]:text-status-rejected *:data-[slot=alert-title]:text-status-rejected *:data-[slot=alert-description]:text-foreground",
        /** Succeeded / verified (green). */
        success:
          "border-status-verified/25 bg-status-verified-muted *:[svg]:text-status-verified *:data-[slot=alert-title]:text-status-verified *:data-[slot=alert-description]:text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/** No implicit role: pass role="alert" for errors that appear after an action, role="status" for live notes. */
function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-sm text-balance text-muted-foreground md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("absolute top-2 right-2", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
