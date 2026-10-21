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
  className,
  contentClassName,
  id,
}: SectionCardProps) {
  return (
    <Card id={id} className={cn(flush && 'gap-0 pb-0', className)}>
      <CardHeader className={cn(flush && 'border-b pb-4')}>
        <CardTitle as={headingLevel}>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      {children !== undefined ? (
        <CardContent className={cn(flush && 'px-0', contentClassName)}>{children}</CardContent>
      ) : null}
      {footer ? <CardFooter className="justify-end gap-2">{footer}</CardFooter> : null}
    </Card>
  );
}
