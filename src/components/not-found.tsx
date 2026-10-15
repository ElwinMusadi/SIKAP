import { FileQuestion } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';

export function NotFound() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileQuestion />
          </EmptyMedia>
          <EmptyTitle>Halaman tidak ditemukan</EmptyTitle>
          <EmptyDescription>Alamat yang Anda buka tidak tersedia atau telah dipindahkan.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link to="/">Kembali ke Beranda</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}
