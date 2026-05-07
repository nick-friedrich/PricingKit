'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAppleApps } from '@/hooks/use-apple-apps';
import { useSetActiveApp } from '@/hooks/use-set-active-app';
import { useAuthStore, useHasHydrated } from '@/store/auth-store';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export default function SelectAppleAppPage() {
  const router = useRouter();
  const hasHydrated = useHasHydrated();
  const isAppleAuthenticated = useAuthStore((s) => s.isAppleAuthenticated);
  const { data: apps, isLoading, error, refetch } = useAppleApps();
  const setActive = useSetActiveApp();

  useEffect(() => {
    if (hasHydrated && !isAppleAuthenticated) {
      router.replace('/setup');
    }
  }, [hasHydrated, isAppleAuthenticated, router]);

  const handlePick = async (bundleId: string) => {
    try {
      await setActive.mutateAsync({ platform: 'apple', bundleId });
      router.push('/dashboard/apple');
    } catch (err) {
      console.error('Failed to set active app', err);
    }
  };

  if (!hasHydrated || isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-2xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Choose an app</CardTitle>
            <CardDescription>
              Pick which app you want to manage pricing for. You can switch
              later from the sidebar.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {error instanceof Error ? error.message : 'Failed to load apps.'}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-2"
                  onClick={() => refetch()}
                >
                  Retry
                </Button>
              </div>
            )}

            {apps && apps.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No apps found for this API key. Verify the key has at least one
                app assigned in App Store Connect → Users and Access.
              </p>
            )}

            <ul className="divide-y">
              {apps?.map((app) => (
                <li key={app.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="font-medium">{app.name}</p>
                    <p className="text-xs text-muted-foreground">{app.bundleId}</p>
                  </div>
                  <Button
                    onClick={() => handlePick(app.bundleId)}
                    disabled={setActive.isPending}
                    size="sm"
                  >
                    Select
                  </Button>
                </li>
              ))}
            </ul>

            {setActive.isError && (
              <p className="mt-3 text-sm text-destructive">
                {setActive.error instanceof Error
                  ? setActive.error.message
                  : 'Failed to set active app.'}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
