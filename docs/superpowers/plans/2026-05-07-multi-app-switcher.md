# Multi-app switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users authenticate once per platform, then switch between apps via a sidebar dropdown — Apple lists apps live from App Store Connect; Google maintains a localStorage history with an "Add app" flow.

**Architecture:** Decouple credentials from active app on both platforms. Apple's `bundleId` and Google's `packageName` move from being baked into the session payload to being independent HTTP-only cookies (`apple_bundle_id`, `gplay_package_name` — both already exist). New `/active-app` endpoints overwrite those cookies. The Zustand store gains a `googleAppHistory` array (localStorage-persisted). Apple's apps come from `GET /v1/apps` via React Query.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind 4 + shadcn/ui (Popover, Dialog), TanStack React Query 5, Zustand 5 with `persist` middleware.

**Spec:** `docs/superpowers/specs/2026-05-07-multi-app-switcher-design.md`

**Verification model:** This codebase has no test runner. Verification per task is `npm run build` (TypeScript check) + `npm run lint`, plus manual UI checks listed in Phase 6. Adding a test runner is out of scope for this plan.

---

## File Map

### New files
- `src/app/api/apple/apps/route.ts` — `GET` lists Apple apps for the current API key.
- `src/app/api/apple/active-app/route.ts` — `POST` swaps the `apple_bundle_id` cookie.
- `src/app/api/active-app/route.ts` — `POST` swaps the `gplay_package_name` cookie.
- `src/app/setup/apple/select-app/page.tsx` — first-time post-Apple-auth app picker.
- `src/components/layout/app-switcher.tsx` — sidebar dropdown.
- `src/components/layout/add-google-app-modal.tsx` — modal opened from the switcher's Google branch.
- `src/hooks/use-apple-apps.ts` — React Query hook over `/api/apple/apps`.
- `src/hooks/use-set-active-app.ts` — mutation for both platforms.

### Modified files
- `src/lib/apple-connect/client.ts` — `hashCredentials` drops `bundleId`; `testAppleConnection` drops `bundleId`-filtered probe; uploaded credentials no longer require `bundleId`.
- `src/app/api/apple/auth/route.ts` — `POST` no longer accepts `bundleId`; `getAppleAuthFromCookies` injects bundleId from the cookie into the returned credentials object.
- `src/middleware/auth.ts` — `getAppleAuthFromCookies` injects bundleId from the cookie into the returned credentials object.
- `src/components/auth/apple-connect-upload.tsx` — drop `bundleId` field; redirect to `/setup/apple/select-app` on success.
- `src/store/auth-store.ts` — add `googleAppHistory` field, add/remove history actions, `setActivePackageName`, `setActiveBundleId` actions.
- `src/components/auth/service-account-upload.tsx` — call `addGoogleAppToHistory` on success.
- `src/components/layout/sidebar.tsx` — render `AppSwitcher` under the platform selector.

---

## Phase 1 — Apple credentials decoupling (no user-visible change)

This phase isolates the refactor: after Phase 1 the Apple flow still works identically end-to-end, but `bundleId` is sourced from the cookie rather than from the session payload. This is the foundation that lets Phase 2 add a swap endpoint.

### Task 1: Drop `bundleId` from `hashCredentials`

**Files:**
- Modify: `src/lib/apple-connect/client.ts:22-24`

- [ ] **Step 1: Open the file and locate the function**

Read `src/lib/apple-connect/client.ts`, find:

```ts
function hashCredentials(credentials: AppleConnectCredentials): string {
  return `${credentials.keyId}-${credentials.issuerId}-${credentials.bundleId}`;
}
```

- [ ] **Step 2: Replace with a bundleId-free hash**

```ts
function hashCredentials(credentials: AppleConnectCredentials): string {
  return `${credentials.keyId}-${credentials.issuerId}`;
}
```

Rationale (no comment in code): the JWT cache key only needs to differ when the *account* changes; the bundleId never affects the JWT.

- [ ] **Step 3: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass. (The `build` runs `tsc` via Next.js.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/apple-connect/client.ts
git commit -m "refactor(apple): drop bundleId from JWT cache key"
```

---

### Task 2: Make `testAppleConnection` bundleId-agnostic

**Files:**
- Modify: `src/lib/apple-connect/client.ts:296-335`

- [ ] **Step 1: Replace the function body**

Find:

```ts
export async function testAppleConnection(
  credentials: AppleConnectCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    // Try to list apps to verify credentials
    await appleApiRequest<AppleApiListResponse<unknown>>(credentials, '/apps', {
      queryParams: {
        'filter[bundleId]': credentials.bundleId,
        limit: '1',
      },
    });
    return { success: true };
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return {
          success: false,
          error: 'Invalid credentials. Please check your API key, Key ID, and Issuer ID.',
        };
      }
      if (error.statusCode === 403) {
        return {
          success: false,
          error: 'Access denied. The API key may not have sufficient permissions.',
        };
      }
      if (error.statusCode === 404) {
        return {
          success: false,
          error: `App with Bundle ID "${credentials.bundleId}" not found in App Store Connect.`,
        };
      }
      return { success: false, error: error.detail };
    }
    return {
      success: false,
      error: 'Failed to connect to App Store Connect. Please check your credentials.',
    };
  }
}
```

Replace with:

```ts
export async function testAppleConnection(
  credentials: AppleConnectCredentials
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await appleApiRequest<AppleApiListResponse<unknown>>(
      credentials,
      '/apps',
      { queryParams: { limit: '1' } }
    );
    if (!response.data || response.data.length === 0) {
      return {
        success: false,
        error: 'No apps found for this API key. Verify the key has at least one app assigned in App Store Connect → Users and Access.',
      };
    }
    return { success: true };
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return {
          success: false,
          error: 'Invalid credentials. Please check your API key, Key ID, and Issuer ID.',
        };
      }
      if (error.statusCode === 403) {
        return {
          success: false,
          error: 'Access denied. The API key may not have sufficient permissions.',
        };
      }
      return { success: false, error: error.detail };
    }
    return {
      success: false,
      error: 'Failed to connect to App Store Connect. Please check your credentials.',
    };
  }
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/lib/apple-connect/client.ts
git commit -m "refactor(apple): testAppleConnection no longer needs bundleId"
```

---

### Task 3: Inject bundleId into credentials at the cookie boundary (middleware helper)

The downstream Apple library functions (`getAppIdForBundleId`, `listInAppPurchases`, etc.) read `credentials.bundleId` and we are intentionally not changing them. Instead, the cookie helpers synthesize a complete `AppleConnectCredentials` by reading the bundleId cookie and merging it onto the session payload.

**Files:**
- Modify: `src/middleware/auth.ts:80-100`

- [ ] **Step 1: Update `getAppleAuthFromCookies` to inject bundleId**

Find:

```ts
export async function getAppleAuthFromCookies(): Promise<AppleAuthResult | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
    const bundleId = cookieStore.get(APPLE_BUNDLE_ID_COOKIE)?.value;

    if (!sessionId || !bundleId) {
      return null;
    }

    const credentials = await getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return null;
    }

    return { credentials, bundleId };
  } catch (error) {
    console.error('Error getting Apple auth from cookies:', error);
    return null;
  }
}
```

Replace with:

```ts
export async function getAppleAuthFromCookies(): Promise<AppleAuthResult | null> {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
    const bundleId = cookieStore.get(APPLE_BUNDLE_ID_COOKIE)?.value;

    if (!sessionId || !bundleId) {
      return null;
    }

    const sessionCredentials = await getAppleSessionCredentials(sessionId);
    if (!sessionCredentials) {
      return null;
    }

    const credentials: AppleConnectCredentials = {
      ...sessionCredentials,
      bundleId,
    };

    return { credentials, bundleId };
  } catch (error) {
    console.error('Error getting Apple auth from cookies:', error);
    return null;
  }
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/middleware/auth.ts
git commit -m "refactor(apple): inject bundleId from cookie into credentials in middleware helper"
```

---

### Task 4: Same injection in the API-route helper

There's a second `getAppleAuthFromCookies` exported from the auth route file (used by direct importers).

**Files:**
- Modify: `src/app/api/apple/auth/route.ts:145-164`

- [ ] **Step 1: Update the function**

Find:

```ts
export async function getAppleAuthFromCookies(): Promise<{
  credentials: AppleConnectCredentials;
  bundleId: string;
} | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionId) {
    return null;
  }

  const credentials = await getAppleSessionCredentials(sessionId);
  if (!credentials) {
    return null;
  }

  // Use bundleId from credentials as single source of truth
  // This prevents mismatch between cookie and session data
  return { credentials, bundleId: credentials.bundleId };
}
```

Replace with:

```ts
export async function getAppleAuthFromCookies(): Promise<{
  credentials: AppleConnectCredentials;
  bundleId: string;
} | null> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  const bundleId = cookieStore.get(BUNDLE_ID_COOKIE)?.value;

  if (!sessionId || !bundleId) {
    return null;
  }

  const sessionCredentials = await getAppleSessionCredentials(sessionId);
  if (!sessionCredentials) {
    return null;
  }

  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId,
  };

  return { credentials, bundleId };
}
```

- [ ] **Step 2: Update the GET handler in the same file** (lines 95-120) **to read bundleId from the cookie**

Find:

```ts
export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

    if (!sessionId) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return NextResponse.json({ authenticated: false });
    }

    // Use bundleId from credentials as single source of truth
    return NextResponse.json({
      authenticated: true,
      bundleId: credentials.bundleId,
      keyId: credentials.keyId,
      issuerId: credentials.issuerId,
    });
  } catch (error) {
    console.error('Apple auth check error:', error);
    return NextResponse.json({ authenticated: false });
  }
}
```

Replace with:

```ts
export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
    const bundleId = cookieStore.get(BUNDLE_ID_COOKIE)?.value ?? null;

    if (!sessionId) {
      return NextResponse.json({ authenticated: false });
    }

    const credentials = await getAppleSessionCredentials(sessionId);
    if (!credentials) {
      return NextResponse.json({ authenticated: false });
    }

    return NextResponse.json({
      authenticated: true,
      bundleId,
      keyId: credentials.keyId,
      issuerId: credentials.issuerId,
    });
  } catch (error) {
    console.error('Apple auth check error:', error);
    return NextResponse.json({ authenticated: false });
  }
}
```

Note: `bundleId` may be `null` after Phase 3 (user has authenticated but not yet picked an app). Dashboard layout will need to handle that — addressed in Phase 3.

- [ ] **Step 3: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/apple/auth/route.ts
git commit -m "refactor(apple): inject bundleId from cookie in route-level helper"
```

---

### Task 5: Smoke-test Apple still works end-to-end

- [ ] **Step 1: Start dev server**

```bash
npm run dev
```

- [ ] **Step 2: Manual check** — open `http://localhost:3000`, log out (if already authed), upload Apple credentials with a bundleId. Confirm the dashboard loads Apple products as before. Confirm logout still clears state.

- [ ] **Step 3: Stop dev server.** Phase 1 is complete with no behavior change.

---

## Phase 2 — New API endpoints

### Task 6: `GET /api/apple/apps`

This route bypasses `requireAppleAuth` (which requires the bundleId cookie). After Phase 3 the bundleId may not be set yet — between auth and first app selection — and the apps list must work in that pre-selection state.

**Files:**
- Create: `src/app/api/apple/apps/route.ts`

- [ ] **Step 1: Create the route file**

```ts
import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  appleApiRequest,
  AppleApiError,
  getAppleSessionCredentials,
} from '@/lib/apple-connect/client';
import type {
  AppleApiListResponse,
  AppleConnectCredentials,
} from '@/lib/apple-connect/types';

const APPLE_SESSION_COOKIE = 'apple_session';

interface AppleAppListItem {
  id: string;
  type: 'apps';
  attributes: {
    name: string;
    bundleId: string;
    sku?: string;
  };
}

export interface AppleAppSummary {
  id: string;
  name: string;
  bundleId: string;
  sku: string | null;
}

export async function GET() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const sessionCredentials = await getAppleSessionCredentials(sessionId);
  if (!sessionCredentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId: sessionCredentials.bundleId ?? '',
  };

  try {
    const response = await appleApiRequest<AppleApiListResponse<AppleAppListItem>>(
      credentials,
      '/apps',
      {
        queryParams: {
          'fields[apps]': 'name,bundleId,sku',
          limit: '200',
        },
      }
    );

    const apps: AppleAppSummary[] = (response.data ?? []).map((app) => ({
      id: app.id,
      name: app.attributes.name,
      bundleId: app.attributes.bundleId,
      sku: app.attributes.sku ?? null,
    }));

    return NextResponse.json({ apps });
  } catch (error) {
    if (error instanceof AppleApiError) {
      if (error.statusCode === 401) {
        return NextResponse.json(
          { error: 'Apple credentials are invalid or expired.' },
          { status: 401 }
        );
      }
      if (error.statusCode === 403) {
        return NextResponse.json(
          { error: 'Apple API key lacks permission to list apps.' },
          { status: 403 }
        );
      }
    }
    console.error('GET /api/apple/apps failed:', error);
    return NextResponse.json(
      { error: 'Failed to fetch apps from App Store Connect.' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Manual check** — start dev server, with an authenticated Apple session, hit `http://localhost:3000/api/apple/apps` in the browser. Expected: JSON `{ apps: [...] }` listing every app the team has access to.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/apple/apps/route.ts
git commit -m "feat(apple): GET /api/apple/apps lists all apps for the API key"
```

---

### Task 7: `POST /api/apple/active-app`

**Files:**
- Create: `src/app/api/apple/active-app/route.ts`

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  appleApiRequest,
  AppleApiError,
  getAppleSessionCredentials,
} from '@/lib/apple-connect/client';
import type {
  AppleApiListResponse,
  AppleConnectCredentials,
} from '@/lib/apple-connect/types';

const APPLE_SESSION_COOKIE = 'apple_session';
const APPLE_BUNDLE_ID_COOKIE = 'apple_bundle_id';
const COOKIE_MAX_AGE = 24 * 60 * 60;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(APPLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const sessionCredentials = await getAppleSessionCredentials(sessionId);
  if (!sessionCredentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { bundleId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const bundleId = body.bundleId;
  if (typeof bundleId !== 'string' || bundleId.trim() === '') {
    return NextResponse.json(
      { error: 'Missing bundleId in request body' },
      { status: 400 }
    );
  }

  // Verify the bundleId is in the team's apps list before persisting.
  const credentials: AppleConnectCredentials = {
    ...sessionCredentials,
    bundleId,
  };

  try {
    const response = await appleApiRequest<
      AppleApiListResponse<{ id: string; attributes: { bundleId: string } }>
    >(credentials, '/apps', {
      queryParams: {
        'filter[bundleId]': bundleId,
        'fields[apps]': 'bundleId',
        limit: '10',
      },
    });
    const exact = (response.data ?? []).find(
      (app) => app.attributes.bundleId === bundleId
    );
    if (!exact) {
      return NextResponse.json(
        {
          error:
            'This app is no longer accessible with your API key — refresh the apps list.',
        },
        { status: 404 }
      );
    }
  } catch (error) {
    if (error instanceof AppleApiError && error.statusCode === 401) {
      return NextResponse.json(
        { error: 'Apple credentials are invalid or expired.' },
        { status: 401 }
      );
    }
    console.error('POST /api/apple/active-app verify failed:', error);
    return NextResponse.json(
      { error: 'Failed to verify app access with App Store Connect.' },
      { status: 500 }
    );
  }

  cookieStore.set(APPLE_BUNDLE_ID_COOKIE, bundleId, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  return NextResponse.json({ ok: true, bundleId });
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/apple/active-app/route.ts
git commit -m "feat(apple): POST /api/apple/active-app to switch active app"
```

---

### Task 8: `POST /api/active-app` (Google)

**Files:**
- Create: `src/app/api/active-app/route.ts`

- [ ] **Step 1: Create the route file**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  createGooglePlayClient,
  getSessionCredentials,
} from '@/lib/google-play/client';

const GOOGLE_SESSION_COOKIE = 'gplay_session';
const GOOGLE_PACKAGE_NAME_COOKIE = 'gplay_package_name';
const COOKIE_MAX_AGE = 24 * 60 * 60;

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(GOOGLE_SESSION_COOKIE)?.value;
  if (!sessionId) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const credentials = await getSessionCredentials(sessionId);
  if (!credentials) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { packageName?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  const packageName = body.packageName;
  if (typeof packageName !== 'string' || packageName.trim() === '') {
    return NextResponse.json(
      { error: 'Missing packageName in request body' },
      { status: 400 }
    );
  }

  // Probe access by listing 1 subscription — same probe used at first auth.
  const client = createGooglePlayClient(credentials);
  try {
    await client.monetization.subscriptions.list({
      packageName,
      pageSize: 1,
    });
  } catch (apiError: unknown) {
    const error = apiError as { code?: number; message?: string };
    if (error.code === 401) {
      return NextResponse.json(
        { error: 'Google credentials are invalid or expired.' },
        { status: 401 }
      );
    }
    if (error.code === 403) {
      return NextResponse.json(
        {
          error:
            "Service account doesn't have access to this app. Invite it via Play Console → Users and permissions.",
        },
        { status: 403 }
      );
    }
    if (error.code === 404) {
      return NextResponse.json(
        {
          error: `App not found. Verify the package name "${packageName}" is correct and the app exists in Play Console.`,
        },
        { status: 404 }
      );
    }
    console.error('POST /api/active-app probe failed:', apiError);
    return NextResponse.json(
      { error: 'Failed to verify Google Play app access.' },
      { status: 500 }
    );
  }

  cookieStore.set(GOOGLE_PACKAGE_NAME_COOKIE, packageName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: COOKIE_MAX_AGE,
    path: '/',
  });

  return NextResponse.json({ ok: true, packageName });
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/active-app/route.ts
git commit -m "feat(google): POST /api/active-app to switch active app"
```

---

## Phase 3 — Apple setup flow change

### Task 9: Apple auth POST stops requiring bundleId

**Files:**
- Modify: `src/app/api/apple/auth/route.ts:16-93`

- [ ] **Step 1: Replace the POST handler**

Find:

```ts
export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const { privateKey, keyId, issuerId, bundleId } = body;

    if (!privateKey || !keyId || !issuerId || !bundleId) {
      return NextResponse.json(
        { error: 'Missing required credentials' },
        { status: 400 }
      );
    }

    const credentials: AppleConnectCredentials = {
      privateKey,
      keyId,
      issuerId,
      bundleId,
    };

    if (!validateAppleCredentials(credentials)) {
      return NextResponse.json(
        { error: 'Invalid credentials format. Please check your .p8 key file.' },
        { status: 400 }
      );
    }

    // Test the connection
    const testResult = await testAppleConnection(credentials);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.error },
        { status: 401 }
      );
    }

    // Create session and store session ID in cookie
    const sessionId = await createAppleSession(credentials);

    const cookieStore = await cookies();

    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    cookieStore.set(BUNDLE_ID_COOKIE, bundleId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });

    return NextResponse.json({
      success: true,
      bundleId,
      keyId,
      issuerId,
    });
  } catch (error) {
    console.error('Apple auth error:', error);
    return NextResponse.json(
      { error: 'Failed to authenticate. Please try again.' },
      { status: 500 }
    );
  }
}
```

Replace with:

```ts
export async function POST(request: NextRequest) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON in request body' },
        { status: 400 }
      );
    }
    const { privateKey, keyId, issuerId } = body;

    if (!privateKey || !keyId || !issuerId) {
      return NextResponse.json(
        { error: 'Missing required credentials' },
        { status: 400 }
      );
    }

    // Use a placeholder bundleId for shape validation only — real value comes
    // from the active-app cookie after first selection.
    const credentials: AppleConnectCredentials = {
      privateKey,
      keyId,
      issuerId,
      bundleId: '',
    };

    if (!validateAppleCredentials(credentials)) {
      return NextResponse.json(
        { error: 'Invalid credentials format. Please check your .p8 key file.' },
        { status: 400 }
      );
    }

    // Test the connection (no longer requires bundleId after Phase 1 Task 2)
    const testResult = await testAppleConnection(credentials);
    if (!testResult.success) {
      return NextResponse.json(
        { error: testResult.error },
        { status: 401 }
      );
    }

    const sessionId = await createAppleSession(credentials);

    const cookieStore = await cookies();
    cookieStore.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: COOKIE_MAX_AGE,
      path: '/',
    });
    // Deliberately do NOT set BUNDLE_ID_COOKIE here — the user picks the app
    // on the /setup/apple/select-app screen, which calls /api/apple/active-app.
    cookieStore.delete(BUNDLE_ID_COOKIE);

    return NextResponse.json({
      success: true,
      keyId,
      issuerId,
    });
  } catch (error) {
    console.error('Apple auth error:', error);
    return NextResponse.json(
      { error: 'Failed to authenticate. Please try again.' },
      { status: 500 }
    );
  }
}
```

- [ ] **Step 2: Update `validateAppleCredentials` to not require bundleId**

In `src/lib/apple-connect/client.ts:121-154`, find:

```ts
  if (typeof obj.bundleId !== 'string' || !obj.bundleId) {
    return false;
  }
```

Remove those three lines entirely. Keep all other checks.

- [ ] **Step 3: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/apple/auth/route.ts src/lib/apple-connect/client.ts
git commit -m "feat(apple): auth POST no longer requires bundleId"
```

---

### Task 10: Drop bundleId field from Apple upload form

**Files:**
- Modify: `src/components/auth/apple-connect-upload.tsx`

- [ ] **Step 1: Remove the bundleId state and input**

In `src/components/auth/apple-connect-upload.tsx`:

1. Delete the line `const [bundleId, setBundleId] = useState('');` (line 34).
2. Delete the entire `<div className="space-y-2">` block containing the Bundle ID `<Label>` and `<Input>` (lines 161-171).
3. In `handleSubmit` (lines 95-148), remove `bundleId` from the validation check and from the request body. Update validation:

   - Find: `if (!state.file || !keyId.trim() || !issuerId.trim() || !bundleId.trim()) {`
   - Replace with: `if (!state.file || !keyId.trim() || !issuerId.trim()) {`

4. Update the request body. Find:

   ```ts
   body: JSON.stringify({
     privateKey,
     keyId: keyId.trim(),
     issuerId: issuerId.trim(),
     bundleId: bundleId.trim(),
   }),
   ```

   Replace with:

   ```ts
   body: JSON.stringify({
     privateKey,
     keyId: keyId.trim(),
     issuerId: issuerId.trim(),
   }),
   ```

5. Replace the `setAppleAuthenticated`/`router.push` calls. Find:

   ```ts
   setAppleAuthenticated({
     bundleId: bundleId.trim(),
     keyId: keyId.trim(),
     issuerId: issuerId.trim(),
   });
   setPlatform('apple');
   router.push('/dashboard');
   ```

   Replace with:

   ```ts
   setAppleAuthenticated({
     bundleId: '',
     keyId: keyId.trim(),
     issuerId: issuerId.trim(),
   });
   setPlatform('apple');
   router.push('/setup/apple/select-app');
   ```

6. Update the Submit button `disabled` prop. Find:

   ```ts
   disabled={
     !state.file ||
     !keyId.trim() ||
     !issuerId.trim() ||
     !bundleId.trim() ||
     state.isLoading
   }
   ```

   Replace with:

   ```ts
   disabled={
     !state.file ||
     !keyId.trim() ||
     !issuerId.trim() ||
     state.isLoading
   }
   ```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/auth/apple-connect-upload.tsx
git commit -m "feat(apple): drop bundleId field from upload form"
```

---

### Task 11: Allow null `bundleId` in Zustand and dashboard layout

After Task 9, `GET /api/apple/auth` returns `bundleId: null` when the user has authenticated but not yet picked an app. The dashboard layout currently feeds this directly into `setAppleAuthenticated`, whose typed signature requires `bundleId: string`. We need to make this nullable.

**Files:**
- Modify: `src/store/auth-store.ts:13-17, 40, 86-96`
- Modify: `src/app/dashboard/layout.tsx:79-91`
- Modify: `src/components/auth/apple-connect-upload.tsx` (already touches `setAppleAuthenticated` after Task 10)

- [ ] **Step 1: Make `AppleAuthData.bundleId` nullable**

In `src/store/auth-store.ts`, find:

```ts
interface AppleAuthData {
  bundleId: string;
  keyId: string;
  issuerId: string;
}
```

Replace with:

```ts
interface AppleAuthData {
  bundleId: string | null;
  keyId: string;
  issuerId: string;
}
```

- [ ] **Step 2: Update `setAppleAuthenticated` to route to picker on null bundleId**

The action keeps its current implementation; the routing decision happens in the dashboard layout (next step). The action just stores whatever bundleId it's given (including `null`).

Find the existing `setAppleAuthenticated` (around lines 86-96):

```ts
      setAppleAuthenticated: ({ bundleId, keyId, issuerId }) =>
        set((state) => ({
          isAppleAuthenticated: true,
          isAuthenticated: true,
          bundleId,
          keyId,
          issuerId,
          platform: state.platform ?? 'apple',
        })),
```

No code change needed (the `bundleId` field on AuthState is already `string | null`). Just confirm the function compiles cleanly with the nullable AppleAuthData type from Step 1.

- [ ] **Step 3: Dashboard layout routes to picker when bundleId missing**

In `src/app/dashboard/layout.tsx`, find:

```tsx
        // Sync Apple auth state
        if (appleData.authenticated) {
          // Invalidate queries if bundleId changed (prevents stale data)
          if (prevBundleId && prevBundleId !== appleData.bundleId) {
            queryClient.invalidateQueries();
          }
          prevBundleId = appleData.bundleId;
          setAppleAuthenticated({
            bundleId: appleData.bundleId,
            keyId: appleData.keyId,
            issuerId: appleData.issuerId,
          });
          hasValidAuth = true;
        }
```

Replace with:

```tsx
        // Sync Apple auth state
        if (appleData.authenticated) {
          // Invalidate queries if bundleId changed (prevents stale data)
          if (prevBundleId && prevBundleId !== appleData.bundleId) {
            queryClient.invalidateQueries();
          }
          prevBundleId = appleData.bundleId ?? null;
          setAppleAuthenticated({
            bundleId: appleData.bundleId ?? null,
            keyId: appleData.keyId,
            issuerId: appleData.issuerId,
          });
          hasValidAuth = true;

          // Authenticated but no app picked yet → force the selector
          if (!appleData.bundleId) {
            if (typeof window !== 'undefined') {
              sessionStorage.removeItem(AUTH_VERIFIED_KEY);
            }
            router.replace('/setup/apple/select-app');
            return;
          }
        }
```

- [ ] **Step 4: Update `apple-connect-upload.tsx` to pass `null`**

In `src/components/auth/apple-connect-upload.tsx`, the Task 10 change set `bundleId: ''`. Update that to `bundleId: null`:

Find:

```ts
      setAppleAuthenticated({
        bundleId: '',
        keyId: keyId.trim(),
        issuerId: issuerId.trim(),
      });
```

Replace with:

```ts
      setAppleAuthenticated({
        bundleId: null,
        keyId: keyId.trim(),
        issuerId: issuerId.trim(),
      });
```

- [ ] **Step 5: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/store/auth-store.ts src/app/dashboard/layout.tsx src/components/auth/apple-connect-upload.tsx
git commit -m "feat(apple): handle authenticated-but-no-app state via select-app redirect"
```

---

## Phase 4 — Zustand store changes

### Task 12: Add `googleAppHistory` field and active-app actions

**Files:**
- Modify: `src/store/auth-store.ts`

- [ ] **Step 1: Add the new entry type and AuthState fields**

After the existing `AppleAuthData` interface (around line 18), add:

```ts
export interface GoogleAppHistoryEntry {
  packageName: string;
  projectId: string;
  clientEmail: string;
  addedAt: number; // unix ms
}
```

In the `AuthState` interface (lines 19-50), add inside the interface body:

```ts
  googleAppHistory: GoogleAppHistoryEntry[];

  addGoogleAppToHistory: (entry: Omit<GoogleAppHistoryEntry, 'addedAt'>) => void;
  removeGoogleAppFromHistory: (packageName: string, clientEmail: string) => void;

  setActivePackageName: (packageName: string) => void;
  setActiveBundleId: (bundleId: string) => void;
```

- [ ] **Step 2: Initialize the field and implement the actions inside `create<AuthState>()(persist(...))`**

In the body returned by the `(set, get) => ({ ... })` factory (lines 54-158), after the existing `appleBaseCountry: 'US',` line, add:

```ts
      googleAppHistory: [],
```

Then, near the existing actions, add:

```ts
      addGoogleAppToHistory: ({ packageName, projectId, clientEmail }) =>
        set((state) => {
          const filtered = state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          );
          return {
            googleAppHistory: [
              ...filtered,
              {
                packageName,
                projectId,
                clientEmail,
                addedAt: Date.now(),
              },
            ],
          };
        }),

      removeGoogleAppFromHistory: (packageName, clientEmail) =>
        set((state) => ({
          googleAppHistory: state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          ),
        })),

      setActivePackageName: (packageName) =>
        set({ packageName }),

      setActiveBundleId: (bundleId) =>
        set({ bundleId }),
```

- [ ] **Step 3: Update `setGoogleAuthenticated` to seed history**

Find the existing `setGoogleAuthenticated` action (lines 75-84). Replace with:

```ts
      setGoogleAuthenticated: ({ packageName, projectId, clientEmail }) =>
        set((state) => {
          const filtered = state.googleAppHistory.filter(
            (entry) =>
              !(
                entry.packageName === packageName &&
                entry.clientEmail === clientEmail
              )
          );
          return {
            isGoogleAuthenticated: true,
            isAuthenticated: true,
            packageName,
            projectId,
            clientEmail,
            platform: state.platform ?? 'google',
            googleAppHistory: [
              ...filtered,
              {
                packageName,
                projectId,
                clientEmail,
                addedAt: Date.now(),
              },
            ],
          };
        }),
```

- [ ] **Step 4: `clearGoogleAuth` does NOT wipe history**

Verify the existing `clearGoogleAuth` (lines 102-114) does not touch `googleAppHistory`. The current implementation already only updates `isGoogleAuthenticated`, `packageName`, `projectId`, `clientEmail`, `isAuthenticated`, `platform` — so no change needed. Confirm by re-reading.

- [ ] **Step 5: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 6: Commit**

```bash
git add src/store/auth-store.ts
git commit -m "feat(store): add googleAppHistory + active-app setters"
```

---

### Task 13: Manual verification of history persistence

- [ ] **Step 1:** `npm run dev`. Log in with Google credentials. Open browser DevTools → Application → Local Storage → `auth-storage`. Confirm `googleAppHistory` contains one entry for the package you just authenticated with.
- [ ] **Step 2:** Hard reload the page. Confirm `googleAppHistory` is still there.
- [ ] **Step 3:** Stop the dev server.

---

## Phase 5 — Switcher UI

### Task 14: Install the shadcn `popover` component

The codebase already has Dialog, DropdownMenu, etc. but check whether Popover exists.

- [ ] **Step 1: Check for the Popover component**

```bash
ls src/components/ui/ | grep -i popover
```

If a `popover.tsx` exists, skip to Task 15.

- [ ] **Step 2: If missing, add it**

```bash
npx shadcn@latest add popover
```

When prompted, accept the default file location (`src/components/ui/popover.tsx`).

- [ ] **Step 3: Confirm install added `@radix-ui/react-popover`**

```bash
grep '"@radix-ui/react-popover"' package.json
```

Expected: a version line. If not, install it: `npm i @radix-ui/react-popover`.

- [ ] **Step 4: Type-check and lint, then commit**

```bash
npm run lint && npm run build
git add src/components/ui/popover.tsx package.json package-lock.json
git commit -m "chore: add shadcn popover component"
```

---

### Task 15: `useAppleApps` hook

**Files:**
- Create: `src/hooks/use-apple-apps.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';
import type { AppleAppSummary } from '@/app/api/apple/apps/route';

interface AppleAppsResponse {
  apps: AppleAppSummary[];
}

export function useAppleApps() {
  const isAppleAuthenticated = useAuthStore((s) => s.isAppleAuthenticated);

  return useQuery({
    queryKey: ['apple', 'apps'],
    enabled: isAppleAuthenticated,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<AppleAppSummary[]> => {
      const response = await fetch('/api/apple/apps');
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'Failed to fetch apps');
      }
      const data = (await response.json()) as AppleAppsResponse;
      return data.apps;
    },
  });
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-apple-apps.ts
git commit -m "feat(hooks): useAppleApps for switcher list"
```

---

### Task 16: `useSetActiveApp` hook

**Files:**
- Create: `src/hooks/use-set-active-app.ts`

- [ ] **Step 1: Create the hook**

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuthStore } from '@/store/auth-store';

type AppleVariables = { platform: 'apple'; bundleId: string };
type GoogleVariables = { platform: 'google'; packageName: string };
export type SetActiveAppVariables = AppleVariables | GoogleVariables;

interface SetActiveAppResponse {
  ok: true;
  bundleId?: string;
  packageName?: string;
}

async function postActiveApp(
  variables: SetActiveAppVariables
): Promise<SetActiveAppResponse> {
  const url =
    variables.platform === 'apple' ? '/api/apple/active-app' : '/api/active-app';
  const body =
    variables.platform === 'apple'
      ? { bundleId: variables.bundleId }
      : { packageName: variables.packageName };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? 'Failed to switch app');
  }
  return (await response.json()) as SetActiveAppResponse;
}

export function useSetActiveApp() {
  const queryClient = useQueryClient();
  const setActiveBundleId = useAuthStore((s) => s.setActiveBundleId);
  const setActivePackageName = useAuthStore((s) => s.setActivePackageName);

  return useMutation({
    mutationFn: postActiveApp,
    onSuccess: (_, variables) => {
      if (variables.platform === 'apple') {
        setActiveBundleId(variables.bundleId);
      } else {
        setActivePackageName(variables.packageName);
      }
      // Invalidate every query — products/subscriptions/app-price are all
      // scoped to the active app and must refetch.
      queryClient.invalidateQueries();
    },
  });
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-set-active-app.ts
git commit -m "feat(hooks): useSetActiveApp mutation for both platforms"
```

---

### Task 17: Apple `/setup/apple/select-app` page

**Files:**
- Create: `src/app/setup/apple/select-app/page.tsx`

- [ ] **Step 1: Create the page**

```tsx
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
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Manual check** — start dev server, log out of Apple, then upload Apple credentials. Expected: redirected to `/setup/apple/select-app` with the apps list. Pick one → redirected to `/dashboard/apple` and products load for that app.

- [ ] **Step 4: Commit**

```bash
git add src/app/setup/apple/select-app/page.tsx
git commit -m "feat(apple): force app picker on first auth"
```

---

### Task 18: Add-Google-app modal

**Files:**
- Create: `src/components/layout/add-google-app-modal.tsx`

- [ ] **Step 1: Create the modal component**

```tsx
'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthStore } from '@/store/auth-store';
import { useSetActiveApp } from '@/hooks/use-set-active-app';

interface AddGoogleAppModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddGoogleAppModal({ open, onOpenChange }: AddGoogleAppModalProps) {
  const clientEmail = useAuthStore((s) => s.clientEmail);
  const projectId = useAuthStore((s) => s.projectId);
  const addGoogleAppToHistory = useAuthStore((s) => s.addGoogleAppToHistory);
  const setActive = useSetActiveApp();

  const [packageName, setPackageName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = packageName.trim();
    if (!trimmed) {
      setError('Please enter a package name.');
      return;
    }
    if (!clientEmail || !projectId) {
      setError('No active service account.');
      return;
    }

    try {
      await setActive.mutateAsync({ platform: 'google', packageName: trimmed });
      addGoogleAppToHistory({ packageName: trimmed, projectId, clientEmail });
      setPackageName('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add app.');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a Google Play app</DialogTitle>
          <DialogDescription>
            Enter the package name of another app this service account has
            access to.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="add-google-package-name">Package name</Label>
            <Input
              id="add-google-package-name"
              placeholder="com.example.app"
              value={packageName}
              onChange={(e) => setPackageName(e.target.value)}
              disabled={setActive.isPending}
              autoFocus
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Service account: <span className="font-mono">{clientEmail ?? '—'}</span>
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={setActive.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={setActive.isPending}>
              {setActive.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Add app
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/add-google-app-modal.tsx
git commit -m "feat(google): add-app modal"
```

---

### Task 19: `AppSwitcher` component

**Files:**
- Create: `src/components/layout/app-switcher.tsx`

- [ ] **Step 1: Create the switcher**

```tsx
'use client';

import { useState } from 'react';
import { Check, ChevronsUpDown, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useAuthStore } from '@/store/auth-store';
import { useAppleApps } from '@/hooks/use-apple-apps';
import { useSetActiveApp } from '@/hooks/use-set-active-app';
import { AddGoogleAppModal } from './add-google-app-modal';

export function AppSwitcher() {
  const platform = useAuthStore((s) => s.platform);
  const activeBundleId = useAuthStore((s) => s.bundleId);
  const activePackageName = useAuthStore((s) => s.packageName);
  const googleAppHistory = useAuthStore((s) => s.googleAppHistory);
  const removeGoogleAppFromHistory = useAuthStore(
    (s) => s.removeGoogleAppFromHistory
  );
  const clientEmail = useAuthStore((s) => s.clientEmail);

  const setActive = useSetActiveApp();
  const appleApps = useAppleApps();

  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  if (!platform) return null;

  const triggerLabel =
    platform === 'apple'
      ? appleApps.data?.find((a) => a.bundleId === activeBundleId)?.name ??
        activeBundleId ??
        'Select app'
      : activePackageName ?? 'Select app';

  const handlePickApple = async (bundleId: string) => {
    try {
      await setActive.mutateAsync({ platform: 'apple', bundleId });
      setOpen(false);
    } catch (err) {
      console.error(err);
    }
  };

  const handlePickGoogle = async (packageName: string) => {
    try {
      await setActive.mutateAsync({ platform: 'google', packageName });
      setOpen(false);
    } catch (err) {
      console.error(err);
    }
  };

  const googleEntries = clientEmail
    ? googleAppHistory.filter((entry) => entry.clientEmail === clientEmail)
    : googleAppHistory;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between"
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          {platform === 'apple' && (
            <div className="max-h-72 overflow-auto py-1">
              {appleApps.isLoading && (
                <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" /> Loading apps…
                </div>
              )}
              {appleApps.error && (
                <div className="px-3 py-2 text-sm text-destructive">
                  {appleApps.error instanceof Error
                    ? appleApps.error.message
                    : 'Failed to load apps.'}
                </div>
              )}
              {appleApps.data?.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No apps found.
                </div>
              )}
              {appleApps.data?.map((app) => {
                const isActive = app.bundleId === activeBundleId;
                return (
                  <button
                    key={app.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => handlePickApple(app.bundleId)}
                    disabled={setActive.isPending}
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{app.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {app.bundleId}
                      </p>
                    </div>
                    {isActive && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })}
              <div className="border-t mt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => appleApps.refetch()}
                >
                  <RefreshCw className="h-3 w-3" /> Refresh apps list
                </button>
              </div>
            </div>
          )}

          {platform === 'google' && (
            <div className="max-h-72 overflow-auto py-1">
              {googleEntries.length === 0 && (
                <div className="px-3 py-2 text-sm text-muted-foreground">
                  No saved apps yet.
                </div>
              )}
              {googleEntries.map((entry) => {
                const isActive = entry.packageName === activePackageName;
                return (
                  <div
                    key={`${entry.packageName}-${entry.clientEmail}`}
                    className="group flex w-full items-center justify-between gap-2 px-3 py-2 hover:bg-muted"
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 text-left text-sm"
                      onClick={() => handlePickGoogle(entry.packageName)}
                      disabled={setActive.isPending}
                    >
                      <p className="truncate font-medium">{entry.packageName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {entry.clientEmail}
                      </p>
                    </button>
                    {isActive ? (
                      <Check className="h-4 w-4 text-primary shrink-0" />
                    ) : (
                      <button
                        type="button"
                        aria-label={`Remove ${entry.packageName} from history`}
                        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeGoogleAppFromHistory(
                            entry.packageName,
                            entry.clientEmail
                          );
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                );
              })}
              <div className="border-t mt-1">
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => {
                    setShowAddModal(true);
                    setOpen(false);
                  }}
                >
                  <Plus className="h-3 w-3" /> Add app
                </button>
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {platform === 'google' && (
        <AddGoogleAppModal
          open={showAddModal}
          onOpenChange={setShowAddModal}
        />
      )}
    </>
  );
}
```

- [ ] **Step 2: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/app-switcher.tsx
git commit -m "feat(switcher): AppSwitcher dropdown for both platforms"
```

---

### Task 20: Render `AppSwitcher` in the sidebar

**Files:**
- Modify: `src/components/layout/sidebar.tsx:65-68`

- [ ] **Step 1: Add the import** at the top of `sidebar.tsx`

After the existing imports, add:

```ts
import { AppSwitcher } from './app-switcher';
```

- [ ] **Step 2: Render the switcher under the platform selector**

Find:

```tsx
      {/* Platform Selector */}
      <div className="px-3 py-3 border-b">
        <PlatformSelector currentPlatform={currentPlatform} />
      </div>
```

Replace with:

```tsx
      {/* Platform Selector */}
      <div className="px-3 py-3 border-b space-y-2">
        <PlatformSelector currentPlatform={currentPlatform} />
        <AppSwitcher />
      </div>
```

- [ ] **Step 3: Type-check and lint**

```bash
npm run lint && npm run build
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat(sidebar): render AppSwitcher under platform selector"
```

---

## Phase 6 — End-to-end manual verification

### Task 21: Apple end-to-end

- [ ] **Step 1:** `npm run dev`. Log out of any existing session.
- [ ] **Step 2:** Upload Apple credentials (no bundleId field). Expected: redirected to `/setup/apple/select-app`. Apps list loads.
- [ ] **Step 3:** Pick app A. Expected: redirected to `/dashboard/apple`. Products list loads for app A.
- [ ] **Step 4:** Click the AppSwitcher in the sidebar. Expected: dropdown shows all apps with check on app A.
- [ ] **Step 5:** Pick app B. Expected: dropdown closes, products list refetches and shows app B's data, AppSwitcher trigger now shows app B.
- [ ] **Step 6:** Click "Refresh apps list" in the dropdown. Expected: apps list refetches.

### Task 22: Google end-to-end

- [ ] **Step 1:** Log out of Google. Upload Google credentials with package `com.example.appA`.
- [ ] **Step 2:** Confirm dashboard loads for `com.example.appA`. Open switcher; expected: one entry (the current app), with a check.
- [ ] **Step 3:** Click "+ Add app". Enter `com.example.appB` (which the same service account has access to). Submit. Expected: modal closes, dashboard refetches for app B, switcher trigger shows `com.example.appB`. Open switcher; expected: two entries with check on app B.
- [ ] **Step 4:** Click on `com.example.appA` in the dropdown. Expected: dashboard refetches for app A.
- [ ] **Step 5:** Hover over `com.example.appB` (the inactive one) in the dropdown; click the trash icon. Expected: entry removed from history. Reload page; expected: only `com.example.appA` in history.
- [ ] **Step 6:** Click "+ Add app", enter a package name the service account does NOT have access to. Expected: modal stays open with the descriptive 403 error; the bad package is NOT added to history.

### Task 23: Cross-platform & regression

- [ ] **Step 1:** With both Google and Apple authenticated, switch between platforms via the existing PlatformSelector. Expected: AppSwitcher updates to show the right platform's apps and active selection.
- [ ] **Step 2:** Log out (clear all auth). Confirm `googleAppHistory` is preserved in localStorage (clearGoogleAuth doesn't wipe it). Re-authenticate Google; confirm history is repopulated and the switcher shows previously-saved apps under the current `clientEmail`.
- [ ] **Step 3:** With a stale `apple_bundle_id` cookie pointing at a bundleId no longer accessible to the API key (manually edit the cookie or revoke the app from the key), call `POST /api/apple/active-app` with that bundleId via the switcher. Expected: 404 with the "no longer accessible — refresh the apps list" message.

If any task fails: stop, debug, fix the offending task before continuing.

---

## Out-of-scope reminders (do not implement here)

- Multi-credential per platform (different service accounts simultaneously).
- Multi-tab on different apps simultaneously.
- Server-side persistence of the Google history.
- Showing the active app name in browser tab title or breadcrumbs.
- Bulk operations across multiple apps in one click.
- Adding a test runner (no Jest/Vitest in this codebase today).
