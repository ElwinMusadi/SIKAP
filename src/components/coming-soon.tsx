import { Hammer } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

interface ComingSoonProps {
  title: string;
  phase: string;
}

export function ComingSoon({ title, phase }: ComingSoonProps) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={title} />
      <Empty className="border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Hammer />
          </EmptyMedia>
          <EmptyTitle>Halaman ini sedang dimigrasikan.</EmptyTitle>
          <EmptyDescription>Fitur {title} akan tersedia pada tahap migrasi berikutnya.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Badge variant="secondary">{phase}</Badge>
        </EmptyContent>
      </Empty>
    </div>
  );
}
