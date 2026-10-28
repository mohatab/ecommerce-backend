# Admin category write route — design

**Status:** approved 2026-10-26. Base: `master` at `c2062e5`.

A single admin-only route, `POST /api/v1/admin/categories`, that closes the
fresh-database half of a recorded deferred limitation. No schema change, no new
dependency, no new abstraction.

---

## 1. The measured gap

`docs/deferred-limitations.md` → *"The admin catalog write surface is unreachable
on a fresh database without a direct database insert"*, **Owner: unscheduled**.
Verified against the tree at `c2062e5`:

| Evidence | Where |
|---|---|
| The only category route is the public list | `src/modules/categories/categories.controller.ts` — one `@Public() @Get()`, no write verb |
| `create()` and `update()` **already exist** with no HTTP caller | `src/modules/categories/categories.service.ts:38` and `:43` |
| …and are already unit-tested | `src/modules/categories/categories.service.spec.ts:61,71` |
| …and already e2e-tested against real PostgreSQL | `test/categories-service.e2e-spec.ts` — create, duplicate name, duplicate slug, unknown-id update, partial update |
| `Product.categoryId` is required, so a fresh database cannot accept a product | `prisma/schema.prisma` — `Product.category` with `onDelete: Restrict` |
| The string `admin/categories` exists **nowhere** in `src/` or `test/` | only in the Phase 2 plan, `docs/superpowers/plans/2026-09-01-phase-2-products.md:2857`, where this controller was specified and then deferred |

So the service layer, its tests, and the original reviewed design all exist. The
missing piece is only the HTTP surface. On a fresh deployment an operator can
bootstrap an ADMIN and authenticate, but every `POST /api/v1/admin/products`
returns 409 (`P2003`) forever, because no category row can be created through the
API.

## 2. Contract

```
POST /api/v1/admin/categories
Authorization: Bearer <ADMIN access token>
Content-Type: application/json

{ "name": "Desks", "slug": "desks" }
```

**201** → `CategoryResponseDto` (`id`, `name`, `slug`, `createdAt`), the existing
DTO unchanged. It deliberately omits `updatedAt`; the explicit field-by-field
`from()` mapper is what prevents field leaks, since `@Exclude()` does nothing on
Prisma's plain objects.

| Status | Cause | Mechanism |
|---|---|---|
| 201 | created | — |
| 400 | invalid or unknown field | global `ValidationPipe` (`whitelist`, `forbidNonWhitelisted`) |
| 401 | missing or invalid token | `JwtAuthGuard`, global and fail-closed |
| 403 | authenticated non-ADMIN | `RolesGuard`, opt-in via `@Roles` |
| 409 | duplicate `name` **or** `slug` | `P2002` → `HttpExceptionFilter`'s `PRISMA_ERROR_MAP` at `src/common/filters/http-exception.filter.ts:22` |

The 409 body is the filter's existing constant — `"A record with these values
already exists"` — which does **not** say which column collided. That is the
project's standing trade-off (one central map, no per-route messages) and this
route does not change it.

**No Prisma error is caught in the controller or the service.** The service's own
comment at `categories.service.ts:36` already records that `P2002` must
propagate. Adding a local `try/catch` here would produce the same error twice
with two different messages, which the standing rule forbids.

## 3. Authorization

One **class-level** `@Roles(Role.ADMIN)` on a dedicated `AdminCategoriesController`,
mirroring `AdminProductsController` (`src/modules/products/admin-products.controller.ts:33-35`).
That file's own comment states why: the likeliest authorization defect is a write
route that forgets `@Roles()`, and a class-level decorator turns several chances
to forget into one. Guard order is unchanged and remains
`ThrottlerGuard → JwtAuthGuard → RolesGuard`.

## 4. Validation

Request body is `CreateCategoryDto`, shaped to the service's existing
`CreateCategoryInput` (`{ name: string; slug: string }`) — no invented fields.

| Field | Rules |
|---|---|
| `name` | string, **trimmed at the DTO boundary**, then non-blank, max **200** |
| `slug` | string, non-blank, max **100**, matches `^[a-z0-9]+(?:-[a-z0-9]+)*$` |

The slug is **client-supplied, never derived from `name`** — that is the existing
service contract, and deriving would invent behaviour the service does not have.

Two consequences worth stating rather than discovering:

- **"Non-blank" needs more than `@IsNotEmpty()`.** `@IsNotEmpty()` rejects `''`,
  `null` and `undefined` but **accepts `"   "`**. The DTO therefore also carries
  `@Matches(/\S/)` on `name`. This makes `name` stricter than
  `CreateProductDto.name` (`src/modules/products/dto/create-product.dto.ts:18-21`),
  which uses `@IsString() @MinLength(1) @MaxLength(200)` and so accepts a
  whitespace-only product name. **Aligning products is explicitly out of scope**
  — it is a behaviour change to a shipped route and belongs in its own task.
- **`name` is trimmed before validation and before persistence** (approved
  follow-up, 2026-10-29). A `@Transform` on the field normalises it first, so
  every rule after it and the row that gets written all see the trimmed value:
  `@MaxLength(200)` applies to the trimmed length, `'   '` trims to `''` and so
  still fails `@Matches(/\S/)`, and `' Desks '` collides with an existing
  `'Desks'` on the UNIQUE index — returning **409** through the same central
  `P2002` map, rather than becoming a second row that renders identically in the
  catalog. The transform passes **non-strings through untouched**, so `@IsString`
  (not a thrown `TypeError`) is what rejects a number or an object; a bare
  `value.trim()` would surface as a 500.
- **`slug` is deliberately NOT trimmed.** Its pattern already forbids whitespace
  anywhere, so a padded slug must be a 400 rather than silently becoming a
  different valid slug.
- **Uniqueness remains case-sensitive**, because `name` and `slug` are plain
  PostgreSQL `@unique` columns. `"Desks"` and `"desks"` are two distinct
  categories and both inserts succeed. Trimming does not change this: it
  normalises surrounding whitespace only, and is neither case folding nor a
  collation change. This is existing schema behaviour, recorded as a known limit
  rather than worked around, since a case-insensitive constraint is a
  migration.

The slug regex rejects a leading hyphen, a trailing hyphen, a doubled hyphen,
uppercase, spaces, and the empty string. This is the first `@Matches` on any DTO
in the repository; it is justified because a slug is a URL identifier and
silently storing `"My Desks!"` is a defect deferred to whoever next reads a URL.

## 5. Scope

**In:** one `POST` route, its DTO, module registration, tests, and the partial
closure of the deferred entry.

**Out, deliberately:**

- `PATCH` and `DELETE` on categories. `CategoriesService.update()` exists and is
  tested, but no route is needed to close this gap, and category deletion still
  needs the orphan policy that Phase 2 declined to invent.
- The **admin product list**. The deferred entry has a second half — a
  deactivated product's id is unrecoverable through the API — and that half
  stays open as its own task (§7).
- Any change to `onDelete: Restrict`, the orphan policy, or product
  activation/deactivation behaviour.
- Any change to the public `GET /api/v1/categories`: its visibility and
  pagination behaviour are untouched.

## 6. No schema change

`Category` already has `id`, `name @unique`, `slug @unique`, `createdAt`,
`updatedAt` and the `products` back-relation. The route writes exactly the two
columns the service already writes. **Zero migrations**, which keeps the standing
rule that migrations are never added outside the phase that owns the model.

## 7. How this closes the gap, and what stays open

Discovery needs no new route: the public `GET /api/v1/categories` has **no
visibility filter** (unlike products, whose reads take a required `visibility`
argument), so a category is listable the moment it is created. The fresh-database
path becomes:

1. `node dist/scripts/bootstrap-admin.js` — existing compiled bootstrap
2. `POST /api/v1/auth/login` as that ADMIN
3. `POST /api/v1/admin/categories` → 201, returns `id`
4. `POST /api/v1/admin/products` with that `categoryId` → 201

Step 4 is what the entry says is impossible today, so step 4 succeeding on a
freshly truncated database is the acceptance evidence.

**The deferred entry closes in part, and must say which part** — the same
convention Phase 6 used for the runtime-image entry. Closed: the category-write
half. **Still open:** the deactivated-product rediscovery half, which needs an
admin product list. Owner stays unscheduled.

## 8. Definition of Done

1. `POST /api/v1/admin/categories` returns **201** with a `CategoryResponseDto`
   body for an ADMIN, and the row is readable back through the public list.
2. The authorization matrix holds: **401** anonymous, **403** CUSTOMER, **201**
   ADMIN.
3. A forged ADMIN token signed with the wrong secret returns **401** and creates
   nothing, with the identical payload under the real secret succeeding as the
   control.
4. Duplicate `name` → **409**; duplicate `slug` → **409**; both through the
   central `P2002` map, with no `try/catch` added to controller or service.
5. Validation negatives return **400**: missing `name`, missing `slug`,
   whitespace-only `name`, over-length `name` (201 chars), over-length `slug`
   (101 chars), each rejected slug form (leading/trailing/doubled hyphen,
   uppercase, space), an unknown extra property, and a non-string `name`.
5a. **Name normalisation:** a name with surrounding whitespace is stored and
   returned trimmed; `' Desks '` against an existing `'Desks'` returns **409**;
   the 200-character maximum is enforced **after** trimming; `'Desks'` and
   `'desks'` stay distinct.
6. **Fresh-database path:** on a truncated database, a category created through
   the API is accepted as `categoryId` by `POST /api/v1/admin/products`.
7. The OpenAPI inventory in `test/swagger.e2e-spec.ts` gains exactly
   `POST /api/v1/admin/categories` — **25 → 26 operations**, assertion updated,
   never relaxed.
8. Negative controls recorded: removing the class-level `@Roles(Role.ADMIN)` makes
   the CUSTOMER case return 201; catching `P2002` in the service makes the
   duplicate case return 500 instead of 409.
9. `docs/deferred-limitations.md` entry marked **partly closed** with the open
   half named; `CLAUDE.md:84` and both README mentions (`:137-141`, `:291-293`)
   updated to match reality.
10. Gates green: `npm run lint:ci`, `npm run build`, `npm test`,
    `npm run test:e2e`. Zero migrations, zero dependency changes,
    `package.json`/`package-lock.json` untouched.
