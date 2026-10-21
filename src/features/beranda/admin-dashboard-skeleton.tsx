import { Skeleton } from '@/components/ui/skeleton';

/** Shared by the lazy-chunk fallback and the dashboard's own loading state (keeps recharts out of Beranda). */
export function AdminDashboardSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Memuat dashboard administrator">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-5">
        <Skeleton className="h-64 rounded-xl lg:col-span-3" />
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
      </div>
    </div>
  );
}
