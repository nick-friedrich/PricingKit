# Multi-app switcher per platform

**Date:** 2026-05-07
**Status:** Approved for implementation planning

## Summary

Today, PricingKit ties exactly one app per platform to a session: the Google `packageName` and Apple `bundleId` are baked into the auth flow and stored in HTTP-only cookies. To work on a different app, the user has to log out and re-authenticate.

This spec adds an in-app switcher that decouples *credentials* from *active app* on both platforms:

- **Apple:** fetch the real apps list from App Store Connect and let the user pick.
- **Google:** maintain a client-side history of previously-authenticated package names (Google's API has no "list apps" endpoint), with an "Add app" flow that reuses the already-uploaded service account.

The switcher lives in the sidebar and survives across reloads.

## Motivation

Many teams manage several apps under a single developer account (Apple) or a single service account (Google). The current single-app-per-platform model forces a friction-heavy logout/re-auth cycle to switch between them. The mental model we want is:

1. Authenticate the *team account* once.
2. Pick which *app* you want to work on, switch freely.

## Platform asymmetry (the central constraint)

This is the constraint that shapes the whole design:

- **Apple App Store Connect** has `GET /v1/apps`, which returns every app the API key has access to. We already call it filtered in `getAppIdForBundleId` (`src/lib/apple-connect/client.ts:338`). Listing all apps means dropping the `filter[bundleId]` query param.
- **Google Play Android Publisher API** has *no* "list apps" endpoint. Every operation requires a `packageName` parameter, and a service account can only access apps that have been individually granted access via the Play Console. Google does not expose enumeration.

Because of this, the two platforms cannot share a single "fetch apps list" implementation. Apple gets a real, server-fetched list. Google gets a client-side history of package names the user has previously authenticated against, stored in localStorage via the existing Zustand persistence.

## Concept model

Two distinct pieces of state per platform:

| State | Google | Apple | Lifetime |
|---|---|---|---|
| Account credentials | Service account JSON | `.p8` + `keyId` + `issuerId` | Encrypted in HTTP-only cookie, 24h |
| Active app | `packageName` | `bundleId` | HTTP-only cookie, swappable via switcher |

The active-app cookie is the source of truth that all API routes consume via `getAuthFromCookies()` (`src/app/api/auth/route.ts:187`) and the Apple equivalent. Switching apps means overwriting that cookie via a new endpoint, then invalidating React Query caches.

## API surface

### New routes

| Route | Method | Body / Query | Behavior |
|---|---|---|---|
| `/api/apple/apps` | GET | — | Calls `/v1/apps` with `fields[apps]=name,bundleId,sku` and `limit=200`. Returns `{ apps: [{ id, name, bundleId, sku }] }`. 401 → bad cookie. |
| `/api/apple/active-app` | POST | `{ bundleId }` | Verifies the bundleId resolves to an app the API key can access (cheap `/apps?filter[bundleId]=...` call, reusing `getAppIdForBundleId`). On success, overwrites the `apple_bundle_id` cookie. On 404, returns `{ error: 'App not accessible — refresh the apps list' }`. |
| `/api/active-app` | POST | `{ packageName }` | Probes Google access with `monetization.subscriptions.list({ packageName, pageSize: 1 })`. On success, overwrites the `gplay_package_name` cookie. On 403/404, returns the same descriptive errors as `/api/auth` does today. |

### Routes changed

- **`POST /api/apple/auth`** (`src/app/api/apple/auth/route.ts`):
  - Drop the `bundleId` requirement from the request body.
  - Stop setting the `apple_bundle_id` cookie here.
  - Replace the bundleId-filtered probe call with an unfiltered `/apps?limit=1` to verify credentials work.
  - Stop persisting `bundleId` into the cached session credentials object — it now only holds the API key fields.
- **`GET /api/apple/auth`**: continues to return `bundleId` (read directly from the `apple_bundle_id` cookie). Behavior unchanged for clients that already consume this — the dashboard layout reads `bundleId` from the response and pushes it into Zustand.

### Reading the active app

The existing cookie helpers (`getAuthFromCookies` for Google, the Apple equivalent in `src/app/api/apple/auth/route.ts:147-163`) continue to return `{ credentials, packageName }` / `{ credentials, bundleId }` by reading the credentials cookie *and* the active-app cookie. No refactor of API route handlers is needed — the active app is still cookie-backed; what expands is *who can change it* (the new `/active-app` endpoint, in addition to the existing auth route).

### `AppleConnectCredentials` shape change

The `bundleId` field is removed from the `AppleConnectCredentials` type — credentials no longer carry the active app:

- `validateAppleCredentials` (`src/lib/apple-connect/client.ts:121`) drops the bundleId check.
- `hashCredentials` (`src/lib/apple-connect/client.ts:22`) drops bundleId from its hash key.
- `getAppIdForBundleId` (`src/lib/apple-connect/client.ts:338`) takes `bundleId` as an explicit second parameter instead of reading `credentials.bundleId`.
- The Apple cookie helper returns `{ credentials, bundleId }` separately, and call sites pass both into downstream functions explicitly.

## Client state changes

### Zustand store (`src/store/auth-store.ts`)

Add to `AuthState`:

```ts
type GoogleAppHistoryEntry = {
  packageName: string;
  projectId: string;
  clientEmail: string;
  addedAt: number; // unix ms
};

interface AuthState {
  // ... existing fields
  googleAppHistory: GoogleAppHistoryEntry[];

  addGoogleAppToHistory: (entry: Omit<GoogleAppHistoryEntry, 'addedAt'>) => void;
  removeGoogleAppFromHistory: (packageName: string) => void;

  // Update only the active-app pointer, leave credentials untouched.
  // Used by the switcher mutation after a successful active-app POST.
  setActivePackageName: (packageName: string) => void;
  setActiveBundleId: (bundleId: string) => void;
}
```

Behavior:

- Dedup key is `(packageName, clientEmail)` — same package under a different service account is a separate entry.
- Auto-populated by `setGoogleAuthenticated` and by the "Add app" success path.
- Persisted to localStorage via the existing `persist` middleware (already configured at `src/store/auth-store.ts:160`). No migration needed; the field defaults to `[]` for existing users.
- `clearGoogleAuth` does **not** wipe the history — credentials and history are independent.

The existing `packageName` and `bundleId` fields keep their meaning: the *currently active* app for that platform. They continue to be set by the dashboard layout's auth-verification effect.

### No Apple history in localStorage

Apple's source of truth is the live `/api/apple/apps` call, fetched on demand by the switcher via React Query (`staleTime: 5 minutes`, with a manual "Refresh" action). We deliberately don't mirror Apple's apps into Zustand — there's no benefit when the live call is cheap and authoritative.

## Components

### `src/components/layout/app-switcher.tsx` (new)

Rendered in `Sidebar` (replaces or sits next to the current platform/app indicator). Structure:

- Trigger: button showing current app name + bundleId/packageName + a `ChevronsUpDown` icon. Falls back to "Select app" if no active app yet.
- Popover content, branched by `useAuthStore(s => s.platform)`:
  - **Apple branch:** Render `useAppleApps()` hook output. Loading → skeleton rows. Error → inline error + retry. Empty → "No apps found for this API key." Each row: app name (primary) + bundleId (muted), check mark on the active one. Footer: "Refresh apps list" item that calls `refetch()`.
  - **Google branch:** Render `googleAppHistory` from Zustand. Each row: package name + clientEmail (muted). Hover shows a small `X` to remove from history. Footer: "+ Add app" item opens the Add App modal.
- Click on a row → `useSetActiveApp.mutate({ platform, app })`.

### `src/components/layout/add-google-app-modal.tsx` (new)

Single `packageName` input + a `clientEmail` read-only display (current service account). Submit → call `POST /api/active-app` with the new package name. On 200, add to history via `addGoogleAppToHistory` and treat as a switch (set as active, invalidate queries, close modal). On 403/404, show the descriptive error inline; do not add to history.

### `src/app/setup/apple/select-app/page.tsx` (new)

First-time post-Apple-auth landing. Renders the apps list (same `useAppleApps` hook) with a forced selection. Pick → `POST /api/apple/active-app` → `/dashboard`. Skipping is not allowed — without a selection, no dashboard data can load.

### `src/components/auth/apple-connect-upload.tsx` (changed)

- Remove the `bundleId` input field and its validation.
- Update the form payload to drop `bundleId`.
- After successful auth, redirect to `/setup/apple/select-app` instead of `/dashboard`.

### `src/components/auth/service-account-upload.tsx` (changed, minor)

- After successful auth, also call `addGoogleAppToHistory` with the package name + projectId + clientEmail returned from the auth response. Continues to redirect to `/dashboard`.

### `src/app/dashboard/layout.tsx` (changed, minor)

The existing auth-verification effect already invalidates queries when `prevPackageName` / `prevBundleId` change (`src/app/dashboard/layout.tsx:64-91`). The switcher mutation will set new active-app cookies, the layout will pick this up on next mount/verify, and invalidation just works. No structural change — confirm via testing.

## Hooks

### `src/hooks/use-apple-apps.ts` (new)

```ts
export function useAppleApps() {
  return useQuery({
    queryKey: ['apple', 'apps'],
    queryFn: () => fetch('/api/apple/apps').then(r => r.json()),
    staleTime: 5 * 60 * 1000,
    enabled: useAuthStore(s => s.isAppleAuthenticated),
  });
}
```

### `src/hooks/use-set-active-app.ts` (new)

```ts
export function useSetActiveApp() {
  const queryClient = useQueryClient();
  const setActiveBundleId = useAuthStore(s => s.setActiveBundleId);
  const setActivePackageName = useAuthStore(s => s.setActivePackageName);
  return useMutation({
    mutationFn: ({ platform, app }) => fetch(`/api/${platform === 'apple' ? 'apple/' : ''}active-app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(platform === 'apple' ? { bundleId: app } : { packageName: app }),
    }).then(handleResponse),
    onSuccess: (_, { platform, app }) => {
      if (platform === 'apple') setActiveBundleId(app);
      else setActivePackageName(app);
      queryClient.invalidateQueries();
    },
  });
}
```

(`setActiveBundleId` / `setActivePackageName` are small new actions on the Zustand store that update only the active-app field, leaving the credentials state alone.)

## Data flow on app switch

```
User clicks app B in switcher
  → useSetActiveApp.mutate({ platform, app })
    → POST /api/<platform>/active-app
      → server probes API access for app B
      → server overwrites the active-app cookie
      ← 200 { ok }
    → onSuccess: queryClient.invalidateQueries()
                 + setActiveBundleId / setActivePackageName in Zustand
  → all dashboard data refetches against the new active app
```

## Error handling

| Scenario | Behavior |
|---|---|
| Apple `/apps` returns 401 | Cookie is bad. Clear Apple session, redirect to `/setup`. (Same pattern as today's auth verification.) |
| Apple active-app POST with a bundleId not in the team's apps | 404 with `{ error: 'This app is no longer accessible with your API key — refresh the apps list.' }`. Switcher shows a toast. |
| Google active-app POST 403 | "Service account doesn't have access to this app. Invite it via Play Console → Users and permissions." (Mirrors the existing setup-flow error language at `src/app/api/auth/route.ts:62-85`.) |
| Google active-app POST 404 | "App not found. Verify the package name is correct and the app exists in Play Console." |
| Add-app modal validation failure | Inline error inside the modal; entry is **not** added to history. |
| Apple apps list empty (`data: []`) | Switcher shows "No apps found for this API key. Verify the key has at least one app assigned in App Store Connect → Users and Access." |

## Testing strategy

- **Unit:**
  - `validateAppleCredentials` — verify it no longer requires `bundleId`.
  - Zustand actions `addGoogleAppToHistory` / `removeGoogleAppFromHistory` — dedup key correctness, history doesn't survive the wrong things.
- **Route handlers:**
  - `GET /api/apple/apps` — happy path (mocked `/v1/apps` response), 401 propagation.
  - `POST /api/apple/active-app` — happy path, "bundleId not in team" → 404, cookie is overwritten.
  - `POST /api/active-app` — happy path, 403 on no-access, cookie is overwritten.
- **Manual / integration:**
  - First-time Apple auth → forced app selection screen → dashboard loads with chosen app.
  - Switch Apple app from sidebar → dashboard data refetches and shows new app's products.
  - Switch Google app from sidebar (existing history entry) → dashboard data refetches.
  - Add new Google app via modal → entry appears in history, switch happens, dashboard data refetches.
  - Add new Google app where the service account lacks access → modal shows error, history unchanged.
  - Refresh Apple apps list manually → cache invalidates, new apps appear.

## Out of scope

- Multi-credential per platform (different service accounts in the same session).
- Multiple tabs operating on different apps simultaneously.
- Server-side persistence of the Google history (sync across browsers/devices).
- Showing the current app name in browser tab title or breadcrumbs.
- Bulk operations across multiple apps in a single click.

## Migration notes

- Existing users with both Google and Apple cookies will keep their current active app on first load post-deploy. No cookie format changes.
- Existing Google users have an empty `googleAppHistory` until they next authenticate or use "Add app". Their currently active package is *not* retroactively added — we only seed history on actions that prove the credential/package combination works right now.
- Existing Apple users will keep their currently active bundleId via the `apple_bundle_id` cookie. No forced re-auth.
