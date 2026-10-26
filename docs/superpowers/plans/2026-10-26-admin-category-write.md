# Admin category write route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `POST /api/v1/admin/categories` so a category can be created through the API, making product creation possible on a fresh database.

**Architecture:** A new admin-only controller in the existing `CategoriesModule`, calling the `CategoriesService.create()` that already ships. One new DTO. No service change, no schema change, no new abstraction.

**Tech Stack:** NestJS, Prisma, `class-validator`, Jest + supertest.

**Spec:** `docs/superpowers/specs/2026-10-26-admin-category-write-design.md`

## Global Constraints

- **Zero migrations.** `prisma/` is unchanged; `git diff master..HEAD -- prisma/` must be empty.
- **Zero dependency changes.** `package.json` and `package-lock.json` untouched.
- **No Prisma error caught in a controller or service.** `P2002` → 409 comes only from `HttpExceptionFilter`'s map at `src/common/filters/http-exception.filter.ts:22`.
- **`POST` only.** No `PATCH`, no `DELETE`, no admin product list.
- **No change** to `onDelete: Restrict`, the orphan policy, product activation/deactivation, or the public `GET /api/v1/categories` (visibility and pagination untouched).
- **`npm run lint:ci`, not `npm run lint`,** is the gate.
- The OpenAPI inventory assertion is **updated, never relaxed**.

## Review Focus

Five input classes the spec implies that a naive implementation would get wrong. Each has a test in the task that owns the code.

1. **Whitespace-only `name` (`"   "`).** `@IsNotEmpty()` accepts it; `@MinLength(1)` accepts it. Expected **400**. Pinned in Task 1 Step 1.
2. **Slug boundary forms.** `-desks`, `desks-`, `a--b`, `Desks`, `my desks`, `""` must each be **400** — the regex rejects all six, but only a test proves the regex is wired to the field. Pinned in Task 1 Step 1.
3. **Case-sensitive uniqueness.** `"Desks"` then `"desks"` both return **201**, because these are plain PostgreSQL `@unique` columns. A reader expects a 409. Pinned in Task 1 Step 1 as the *documented* behaviour, so a future case-folding change breaks a test rather than surprising someone.
4. **Over-length input.** 201-char `name` and 101-char `slug` must be **400**, not a 500 from a database length error (there is no database length limit, so only the DTO stops them).
5. **Forged ADMIN token.** A token with `role: ADMIN` signed with the wrong secret must be **401** and must create nothing, with the same payload under the real secret as the control. Mirrors `test/admin-products.e2e-spec.ts:228`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/modules/categories/dto/create-category.dto.ts` | **create** — request body shape and validation |
| `src/modules/categories/admin-categories.controller.ts` | **create** — the admin-only route |
| `src/modules/categories/categories.module.ts` | **modify** — register the controller |
| `test/admin-categories.e2e-spec.ts` | **create** — authorization matrix, validation negatives, duplicates, fresh-database path |
| `test/swagger.e2e-spec.ts` | **modify** — inventory 25 → 26 |
| `docs/deferred-limitations.md` | **modify** — partial closure |
| `CLAUDE.md` | **modify** — the stale rule at `:84` |
| `README.md` | **modify** — the caveats at `:137-141` and `:291-293` |

`AppModule` needs no change: `CategoriesModule` is already imported.

---

## Task 1: The route, guarded and proven

**Files:**
- Create: `src/modules/categories/dto/create-category.dto.ts`
- Create: `src/modules/categories/admin-categories.controller.ts`
- Modify: `src/modules/categories/categories.module.ts`
- Create: `test/admin-categories.e2e-spec.ts`
- Modify: `test/swagger.e2e-spec.ts`

**Interfaces:**
- Consumes: `CategoriesService.create(input: CreateCategoryInput): Promise<Category>` (`categories.service.ts:38`); `CreateCategoryInput = { name: string; slug: string }` (`:6-9`); `CategoryResponseDto.from(category: Category)` (`dto/category-response.dto.ts`); `Roles` from `src/common/decorators/roles.decorator`.
- Produces: `AdminCategoriesController` with `create(dto: CreateCategoryDto): Promise<CategoryResponseDto>`; `CreateCategoryDto { name: string; slug: string }`.

No unit test is added: the controller is a thin delegation with no branching, and `CategoriesService.create()` already has unit coverage at `categories.service.spec.ts:61` and e2e coverage in `test/categories-service.e2e-spec.ts`. The new behaviour is HTTP-level — routing, guards, validation, status mapping — which only an e2e test exercises.

- [ ] **Step 1: Write the failing e2e suite**

Create `test/admin-categories.e2e-spec.ts`. Follow `test/admin-products.e2e-spec.ts` for setup: `createTestApp()`, `truncateAll(prisma)` in `beforeEach`, users via `createUser(prisma, { role: Role.ADMIN })`, tokens via `app.get(TokenService).signAccessToken(user)` (never `/auth/login`, so the 5/min auth throttle stays out of the loop).

```typescript
const PATH = '/api/v1/admin/categories';
const body = { name: 'Desks', slug: 'desks' };

describe('POST /api/v1/admin/categories (e2e)', () => {
  // --- authorization matrix ---
  it('returns 401 without a token', /* expect(401), and 0 rows in categories */);
  it('returns 403 for a CUSTOMER token', /* expect(403), and 0 rows */);
  it('returns 201 with the created category for an ADMIN', /* expect(201); body matches { name: 'Desks', slug: 'desks' }, has id + createdAt, and has NO updatedAt */);

  // Review Focus 5 — mirrors admin-products.e2e-spec.ts:228
  it('returns 401 for a forged ADMIN token signed with the wrong secret, and creates nothing');
  it('control: the identical payload signed with the real secret succeeds');

  // --- discoverability: the point of the route ---
  it('returns the new category from the public GET /api/v1/categories');

  // --- duplicates, through the central P2002 map ---
  it('returns 409 for a duplicate name');
  it('returns 409 for a duplicate slug');
  // Review Focus 3 — documented behaviour, not a wish
  it('treats name case as distinct: "Desks" then "desks" both return 201');

  // --- validation negatives, all 400 ---
  it.each([
    ['missing name', { slug: 'desks' }],
    ['missing slug', { name: 'Desks' }],
    ['whitespace-only name', { name: '   ', slug: 'desks' }],        // Review Focus 1
    ['name over 200 chars', { name: 'x'.repeat(201), slug: 'desks' }], // Review Focus 4
    ['slug over 100 chars', { name: 'Desks', slug: 'd'.repeat(101) }], // Review Focus 4
    ['leading hyphen slug', { name: 'Desks', slug: '-desks' }],       // Review Focus 2
    ['trailing hyphen slug', { name: 'Desks', slug: 'desks-' }],
    ['doubled hyphen slug', { name: 'Desks', slug: 'office--desks' }],
    ['uppercase slug', { name: 'Desks', slug: 'Desks' }],
    ['spaced slug', { name: 'Desks', slug: 'my desks' }],
    ['empty slug', { name: 'Desks', slug: '' }],
    ['unknown extra field', { ...body, colour: 'red' }],
  ])('returns 400 for %s', /* expect(400) */);

  it.each([['standing-desks'], ['desks2'], ['a']])(
    'accepts the valid slug %s', /* expect(201) */);
});
```

- [ ] **Step 2: Add the fresh-database acceptance test to the same file**

This is the assertion that discharges the deferred entry. It must run against a truncated database and use only the API.

```typescript
it('lets an ADMIN create a product against a category created through the API', async () => {
  // 1. POST the category, take `id` from the 201 body
  // 2. POST /api/v1/admin/products with that id as categoryId
  // 3. expect 201, and the product's categoryId to equal the category's id
});
```

Build the product payload from `CreateProductDto`'s required fields only: `name`, `description`, `priceCents`, `categoryId`.

- [ ] **Step 3: Run the suite to verify it fails**

Run: `docker compose up -d postgres-test` then `npm run test:e2e -- test/admin-categories.e2e-spec.ts`
Expected: every case FAILS with **404**, because the route does not exist.

- [ ] **Step 4: Write `CreateCategoryDto`**

Create `src/modules/categories/dto/create-category.dto.ts` exporting `CreateCategoryDto` with two properties, following `CreateProductDto`'s decorator style (`@ApiProperty` + `class-validator`):

- `name!: string` — `@IsString()`, `@MaxLength(200)`, and `@Matches(/\S/)`. The `@Matches(/\S/)` is load-bearing and must not be "simplified" to `@IsNotEmpty()` or `@MinLength(1)`: both accept `"   "`, which Review Focus 1 forbids. Add a comment saying so, and that this is deliberately stricter than `CreateProductDto.name`.
- `slug!: string` — `@IsString()`, `@MaxLength(100)`, `@Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)`. Comment that the pattern also enforces non-blank, so no separate emptiness check is needed.

`@ApiProperty` examples: `'Desks'` and `'desks'`.

- [ ] **Step 5: Write `AdminCategoriesController`**

Create `src/modules/categories/admin-categories.controller.ts`, copying the shape of `src/modules/products/admin-products.controller.ts:32-36`: `@ApiTags('admin-categories')`, `@ApiBearerAuth()`, `@Roles(Role.ADMIN)`, `@Controller('admin/categories')`.

One route: `@Post()`, `@ApiOperation({ summary: 'Create a category' })`, and `@ApiResponse` entries for 201 / 400 / 401 / 403 / 409 — the 409 described as `'name or slug already exists'`. Body:

```typescript
async create(@Body() dto: CreateCategoryDto): Promise<CategoryResponseDto> {
  return CategoryResponseDto.from(
    await this.categoriesService.create({ name: dto.name, slug: dto.slug }),
  );
}
```

Pass the two fields explicitly rather than spreading `dto` — the same convention `AdminProductsController.create()` uses, so an added DTO field can never reach the service unreviewed. No `try/catch`.

- [ ] **Step 6: Register the controller**

Modify `src/modules/categories/categories.module.ts`: add `AdminCategoriesController` to `controllers`. Leave `providers` and `exports` alone.

- [ ] **Step 7: Update the OpenAPI inventory**

Modify `test/swagger.e2e-spec.ts`: add `'POST /api/v1/admin/categories'` to the pinned `operations()` array. The array is sorted, so it goes immediately before `'POST /api/v1/admin/maintenance/{job}/run'`. Count goes **25 → 26**.

- [ ] **Step 8: Run the suite to verify it passes**

Run: `npm run test:e2e -- test/admin-categories.e2e-spec.ts test/swagger.e2e-spec.ts`
Expected: PASS, both files.

- [ ] **Step 9: Negative control — the route is actually protected**

Remove the class-level `@Roles(Role.ADMIN)` from the controller. Re-run the suite.
Expected: the CUSTOMER case **fails** by returning 201 instead of 403 — the assertion that names authorization. Record the output, restore the decorator, re-run, confirm green.

- [ ] **Step 10: Negative control — the central duplicate mapping is preserved**

In `CategoriesService.create()`, wrap the `prisma.category.create` call in a `try/catch` whose `catch` rethrows a plain `new Error('duplicate')`, so the Prisma error never reaches `HttpExceptionFilter`'s map. Re-run.
Expected: the duplicate-name case **fails** by returning 500 instead of 409 — proving the 409 comes from `HttpExceptionFilter` and not from anywhere local. Record the output, revert the service byte-exactly (`git checkout -- src/modules/categories/categories.service.ts`), confirm `git diff -- src/` shows no service change, re-run, confirm green.

- [ ] **Step 11: Full gates**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```
Report measured suite and test counts. `npm test` should be unchanged in count (no unit test added); e2e gains one suite.

- [ ] **Step 12: Verify scope, then commit**

```bash
git diff --stat master..HEAD -- prisma/                        # must be EMPTY
git diff master..HEAD -- package.json package-lock.json        # must be EMPTY
git diff --stat
```

```bash
git add src/modules/categories/dto/create-category.dto.ts \
        src/modules/categories/admin-categories.controller.ts \
        src/modules/categories/categories.module.ts \
        test/admin-categories.e2e-spec.ts \
        test/swagger.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat(categories): add the admin category create route

CategoriesService.create() has shipped since Phase 2 with no HTTP caller, so
on a fresh database every POST /api/v1/admin/products returned 409 (P2003) --
no category row could be created through the API at all. This adds the one
route that closes that: POST /api/v1/admin/categories, admin-only through a
single class-level @Roles(Role.ADMIN), the same structural mitigation
AdminProductsController uses.

The slug is client-supplied, matching the service's existing
CreateCategoryInput; deriving it from the name would invent behaviour the
service does not have. `name` carries @Matches(/\S/) rather than
@IsNotEmpty(), which accepts "   " -- deliberately stricter than
CreateProductDto.name, which does not.

Duplicate name or slug returns 409 through HttpExceptionFilter's existing
P2002 map, with no local try/catch; a control that swallows the error in the
service was recorded returning 500 instead.

Zero migrations, zero dependency changes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Acceptance criteria:**
- Matrix: 401 anonymous, 403 CUSTOMER, 201 ADMIN; forged-token 401 with its real-secret control.
- 409 on duplicate name and on duplicate slug, both from the central map; case-distinct names both 201.
- Every validation negative in Step 1 returns 400; every valid slug form returns 201.
- Fresh-database path: product created against an API-created category.
- OpenAPI inventory 26, assertion updated not relaxed.
- Both negative controls recorded with the failing assertion named, and both reverted byte-exactly.
- Zero migrations, zero dependency changes.

**Independent review focus:**
1. Is `@Roles(Role.ADMIN)` **class-level**, not per-route?
2. Does any `try/catch` or Prisma-error branch exist in the new controller or in the service?
3. Does the DTO reject `"   "` for `name`? Check the decorator, not just the test.
4. Was the OpenAPI assertion updated, or relaxed/deleted?
5. Were both negative controls actually run, each failing on the assertion naming its property — and is `src/` byte-identical afterwards?
6. Did anything outside the five listed files change?

---

## Task 2: Close the deferred entry, in part

**Files:**
- Modify: `docs/deferred-limitations.md`
- Modify: `CLAUDE.md:84`
- Modify: `README.md:137-141` and `README.md:291-293`

**Interfaces:** consumes nothing; produces nothing code depends on.

- [ ] **Step 1: Mark the deferred entry partly closed**

In `docs/deferred-limitations.md`, the entry *"The admin catalog write surface is unreachable on a fresh database without a direct database insert"*. Follow the file's own convention and Phase 6's precedent for a half-closed entry: **do not strike the heading** (it still documents an open gap), append `— PARTLY CLOSED` to it, and add a closing note above the preserved original text saying:

- **Closed:** `POST /api/v1/admin/categories` ships; a fresh database now accepts a product through the API alone. Cite the route and the e2e test name.
- **Still open:** the deactivated-product rediscovery half — no admin product list, the public list excludes inactive products, the public detail route 404s on one, so a lost id is undiscoverable. **Owner: unscheduled.**
- The original text is preserved verbatim below and describes the pre-closure state.

**Never delete the entry.** The file's rule is to close by shipping and say so.

- [ ] **Step 2: Update the stale `CLAUDE.md` rule**

`CLAUDE.md:84` currently opens *"**Phase 2 ships no category write route, and this is a known, undischarged gap**"*, which is now false. Rewrite that bullet to record what actually holds: the route ships and is admin-only; the slug is client-supplied; `name` is validated more strictly than `CreateProductDto.name` and products were deliberately not aligned; **the product-rediscovery half is still open and still must not be added as a drive-by**; and category deletion remains unimplemented because it needs an orphan policy, with `onDelete: Restrict` unchanged.

- [ ] **Step 3: Update both README mentions**

- `README.md:137-141` (Quick start) — the caveat that a product cannot be created until a category exists becomes the two-step instruction: create a category, then the product. Keep it short; this is the first screen.
- `README.md:291-293` (the catalog section) — same correction, and keep the sentence about the deactivated product, which is still true.

- [ ] **Step 4: Verify no claim went stale**

```bash
grep -rn 'no category write route\|ships no category' README.md CLAUDE.md docs/
```
Expected: no hit that asserts the route is absent, except inside the preserved historical text of the deferred entry.

- [ ] **Step 5: Gates and commit**

```bash
npm run lint:ci && npm run build && npm test
git diff --check
```
No e2e needed: this task touches no TypeScript.

```bash
git add docs/deferred-limitations.md CLAUDE.md README.md
git commit -m "$(cat <<'EOF'
docs: close the category-write half of the catalog deferred entry

The entry closes IN PART and says which part: POST /api/v1/admin/categories
ships, so a fresh database now accepts a product through the API alone. The
deactivated-product rediscovery half stays open -- no admin product list, the
public list excludes inactive products, and the public detail route 404s on
one, so a lost id is still undiscoverable. Owner: unscheduled.

The original entry text is preserved; it describes the pre-closure state.
onDelete: Restrict and the orphan policy are unchanged, and category deletion
remains unimplemented for the same reason as before.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

**Acceptance criteria:**
- The entry is marked partly closed, names the still-open half with an owner, and **no entry is deleted**.
- `CLAUDE.md` no longer asserts the route is missing, and still forbids adding the product list as a drive-by.
- Both README mentions corrected; the quick start now describes a path that works.
- No source file changed in this task.

**Independent review focus:**
1. Was any deferred entry deleted or struck through rather than marked partly closed?
2. Does the entry name the still-open half explicitly, with an owner?
3. Does any document still claim the category route does not exist, outside preserved historical text?
4. Does any document now overclaim — e.g. that the whole entry is closed?

---

## Self-review notes

**Spec coverage.** Spec §2 contract → Task 1 Steps 4-5; §3 authorization → Step 1 matrix + Step 9 control; §4 validation → Step 1 negatives + Step 4; §5 scope → Global Constraints; §6 no schema change → Step 12 scope check; §7 fresh-database path → Step 2; §7 partial closure → Task 2; §8 DoD items 1-8 → Task 1, items 9-10 → Task 2 and Step 11.

**Proportion.** Two tasks for one route, one DTO, one module line, and a documentation closure. No unit test is prescribed because the only new code is a thin delegation whose behaviour is HTTP-level; the service beneath it already has unit and e2e coverage.

**Known contradiction, reported not resolved.** The approved validation makes `name` non-blank, which `CreateProductDto.name` is not — a shipped route accepts a whitespace-only product name. The two DTOs will therefore disagree. Aligning products is a behaviour change to a shipped endpoint and is out of scope here; it is recorded in the spec (§4) so the inconsistency is deliberate rather than discovered.
