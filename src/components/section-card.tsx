import type { ReactNode } from 'react';
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

interface SectionCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Right-aligned header action (link "Lihat semua", small button, menu). */
  action?: ReactNode;
  footer?: ReactNode;
  children?: ReactNode;
  /** Heading level: h2 directly under the page h1 (default), h3 when nested in another section. */
  headingLevel?: 'h2' | 'h3';
  /** Content touches the card edges (tables, lists with their own padding). */
  flush?: boolean;
  /** Labelled action button: on phones it moves under the description instead of squeezing the title. */
  wideAction?: boolean;
  className?: string;
  contentClassName?: string;
  id?: string;
}

/** A titled card section: the title is a real heading, so screen-reader users can jump between sections. */
export function SectionCard({
  title,
  description,
  action,
  footer,
  children,
  headingLevel = 'h2',
  flush,
  wideAction,
  className,
  contentClassName,
  id,
}: SectionCardProps) {
  return (
    <Card id={id} className={cn(flush && 'gap-0 pb-0', className)}>
      {/* Important flag: the base `has-data-[slot=card-action]:grid-cols-[1fr_auto]` would otherwise win. */}
      <CardHeader className={cn(flush && 'border-b pb-4', wideAction && 'max-sm:grid-cols-1!')}>
        <CardTitle as={headingLevel}>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? (
          <CardAction className={cn(wideAction && 'max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:mt-2 max-sm:justify-self-start')}>
            {action}
          </CardAction>
        ) : null}
      </CardHeader>
      {children !== undefined ? (
        <CardContent className={cn(flush && 'px-0', contentClassName)}>{children}</CardContent>
      ) : null}
      {footer ? <CardFooter className="justify-end gap-2">{footer}</CardFooter> : null}
    </Card>
  );
}
