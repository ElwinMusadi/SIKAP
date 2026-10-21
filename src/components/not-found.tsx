import { ArrowLeft, FileQuestion, House } from 'lucide-react';
import { Link } from 'react-router';
import { StatusPage } from '@/components/status-page';
import { Button } from '@/components/ui/button';

export function NotFound() {
  return (
    <StatusPage
      fullScreen
      code="404"
      icon={FileQuestion}
      title="Halaman tidak ditemukan"
      description="Alamat yang Anda buka tidak tersedia atau telah dipindahkan."
      actions={
        <>
          <Button variant="outline" onClick={() => window.history.back()}>
            <ArrowLeft data-icon="inline-start" />
            Kembali
          </Button>
          <Button asChild>
            <Link to="/">
              <House data-icon="inline-start" />
              Ke Beranda
            </Link>
          </Button>
        </>
      }
    />
  );
}
