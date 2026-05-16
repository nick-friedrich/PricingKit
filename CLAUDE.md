# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

PricingKit is a Next.js application for managing in-app product and subscription pricing across Google Play Store and Apple App Store. It enables developers to view, edit, and bulk-update pricing by region with currency conversion and multiple pricing strategies: PPP (World Bank), Big Mac Index, Netflix Index, and custom multipliers.

## Commands

```bash
npm run dev          # Start development server (http://localhost:3000)
npm run build        # Production build
npm start            # Start production server
npm run lint         # Run ESLint
npm test             # Run Vitest test suite
npm test -- <path>   # Run specific test file(s)
```

## Architecture

### Tech Stack
- **Framework:** Next.js 16 (App Router) with TypeScript
- **UI:** Tailwind CSS 4 + shadcn/ui (New York style) + Radix UI
- **State:** Zustand (client state with localStorage persistence) + TanStack React Query (server state)
- **Forms:** React Hook Form + Zod validation
- **APIs:** googleapis (Google Play), custom JWT client (Apple App Store Connect)

### Key Directories

```
/src/app/api/           # API routes - Google Play and Apple endpoints
  /products             # Google Play products CRUD
  /subscriptions        # Google Play subscriptions
  /apple/               # Apple App Store routes (parallel structure)
  /bulk                 # Bulk price update operations
  /exchange-rates       # Currency conversion endpoint
  /ppp                  # PPP calculation endpoint

/src/lib/
  /google-play/         # Google Play Developer API integration
  /apple-connect/       # Apple App Store Connect API (JWT auth, price tiers)
  /exchange-rates/      # Open Exchange Rates API client with disk cache
  /conversion-indexes/  # PPP, Big Mac, Netflix indexes + FALLBACK_EXCHANGE_RATES

/src/hooks/             # React Query hooks for products/subscriptions
/src/store/             # Zustand stores (auth-store, selection-store)
/src/components/ui/     # shadcn/ui components
```

### Data Flow & State Management

**No database** - stateless architecture:
- Session credentials stored encrypted in HTTP-only cookies (24-hour expiry)
- Exchange rates cached to disk (`.exchange-rates.json`, 6-hour TTL)
- Dev sessions persisted to `.sessions.json`
- Client auth state persisted to localStorage via Zustand

**API Authentication:**
- Google Play: Service account JSON credentials
- Apple: JWT with private key (.p8 file), issuer ID, and key ID

### API Route Patterns
- RESTful: `GET/PATCH/DELETE /api/products/[sku]`
- Platform-specific: `/api/products` (Google) vs `/api/apple/products` (Apple)
- Error codes: 401 (auth), 403 (permission), 404 (not found), 429 (rate limit)
- Public Index Checker page at `/index-checker` — no auth, exposes pricing strategies for any user

### Currency & Pricing
- **Pricing strategies:** `'direct' | 'ppp' | 'bigmac' | 'netflix' | 'custom'` — defined in `/lib/google-play/currency.ts` (`PricingStrategy` type + `calculateRegionalPrice` switch)
- **Multiplier convention:** all indexes clamp to `[0.1, 2.0]`, normalized to base region (not US directly)
- **Canonical territories:** `getSupportedAppleTerritories()` in `/lib/apple-connect/territories.ts` — use for coverage checks when adding new indexes
- **Exchange rates:** Open Exchange Rates API with caching
- **PPP multipliers:** Static `PRICING_INDEX` in `/lib/conversion-indexes/ppp.ts`; partial fallback to `FALLBACK_EXCHANGE_RATES` with UI banner when API fails
- **Apple price tiers:** Large mapping file (`price-tier-data.ts`, 400K+ lines)

### Adding a new pricing strategy
Touchpoints (all required, in order):
1. `/lib/conversion-indexes/<name>.ts` — data + `getXMultiplier()` + `DEFAULT_X_MULTIPLIER`
2. `/lib/google-play/currency.ts` — add to `PricingStrategy` union, `multiplierSource`, switch case in `calculateRegionalPrice`
3. `/app/api/ppp/route.ts` — surface multiplier in static + dynamic data shapes
4. UI: `/components/products/bulk-pricing-modal.tsx`, `/components/subscriptions/bulk-pricing-modal.tsx`, `/components/subscriptions/apple-subscription-bulk-pricing-modal.tsx`, `/app/index-checker/page.tsx`
5. Tests: data module + new case in `currency.test.ts`

## Environment Variables

```
ENCRYPTION_KEY           # For encrypting credentials in cookies (recommended)
OPEN_EXCHANGE_RATES_APP_ID  # API key for currency conversion
```

## Path Alias

TypeScript path alias: `@/*` maps to `src/*`

## Repo hygiene
- Do not commit planning/implementation `.md` files to repo root. Plans belong in PR descriptions, not the tree.
