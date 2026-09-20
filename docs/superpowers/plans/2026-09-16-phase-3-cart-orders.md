# Phase 3 — Cart, Orders, and Safe Checkout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a persistent cart and a transactional checkout that cannot oversell stock under concurrency, proven by a committed e2e test that fails against a naive implementation.

**Architecture:** Two new feature modules (`cart`, `orders`) plus stock methods added to the existing `ProductsService`. Checkout runs in one Prisma interactive transaction: it locks the caller's `Cart` row, replays the idempotency key, decrements each product with a conditional `updateMany` whose predicate travels with the write, snapshots prices while holding those row locks, creates the order, and clears the cart. Cancellation restores stock through the same compare-and-swap idiom.

**Tech Stack:** NestJS 11, Prisma 6 (PostgreSQL), class-validator, Jest (unit + e2e against dockerized Postgres on 5433), Swagger. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-16-phase-3-cart-orders-design.md` — read it before starting. Every "why" lives there; this plan is the "how". Section references below (§5.3, D11, C7…) point into that spec.

## Global Constraints

- **No new dependencies.** Nothing from Phases 4–6: no payment code, no Redis, no BullMQ, no background/scheduled job, no admin order routes, no `PAID` status.
- **Do not close Phase 2's deferred limitations in passing** (§C5): no admin category route, no admin product list. Tests create categories via `test/factories/category.factory.ts`.
- `src/config/` stays the only reader of `process.env`; `test/` is the only other exception. **Phase 3 adds no environment variable.**
- **Money is integer minor units everywhere.** No floating-point price, ever.
- `enableImplicitConversion` is `false`: every numeric body/query field needs an explicit `@Type(() => Number)`.
- **Prisma errors are never caught in a service or controller.** `P2002`/`P2003`/`P2025` are mapped only in `HttpExceptionFilter`. `P2028`, `P2034`, and `CHECK` violations stay unmapped 500s (§C3).
- Transactional service methods take `tx: Prisma.TransactionClient` as a **required first parameter, no default** (§7).
- **Product locks are always taken in ascending `productId` order** (§5.4).
- **No external I/O inside the checkout transaction** — no HTTP, no JWT signing, no argon2 (§5.5).
- Controllers never return Prisma objects; every response goes through a DTO with a static `from()` (CLAUDE.md).
- Every route gets `@ApiTags`, `@ApiOperation`, `@ApiResponse`.
- **`maxWorkers: 1` in `test/jest-e2e.json` stays.** Never raise it (§8.6).
- Test factories insert through the Prisma client, never `$executeRaw` (ids are client-side `uuid(7)`).
- **Typed Jest mocks.** A bare `jest.Mock` is `Mock<any, any, any>` and trips `@typescript-eslint/no-unsafe-member-access` under `npm run lint:ci` the moment a test reads `.mock.calls[0][0]`. Declare `jest.Mock<TReturn, TArgs>` and construct with `jest.fn<TReturn, TArgs>()`. Never fix this with a cast or an eslint-disable (CLAUDE.md rule 4).
- **Gate for every task:** `npm run lint:ci` (not `npm run lint` — `--fix` hides the failure), `npm run build`, `npm test`, and `npm run test:e2e`. All four green before the task's commit.
- **Commit at the end of each task, exactly once**, with the message given in that task. Do not push. Do not commit anything outside the task's file list (the untracked `bash.exe.stackdump` stays untracked).

## File map

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | `stockQuantity`, `Cart`, `CartItem`, `Order`, `OrderItem`, `OrderStatus` | 1 |
| `prisma/migrations/*_phase3_cart_orders_stock/migration.sql` | generated, then hand-edited to add 4 CHECK constraints | 1 |
| `test/factories/{cart,order}.factory.ts` | new factories | 1 |
| `src/modules/products/types/stock-refusal.ts` | `StockRefusal` union | 2 |
| `src/modules/products/products.service.ts` | `decrementStock`, `incrementStock`, `describeRefusal`, `findManyForSnapshot`, `adjustStock` | 2 |
| `src/modules/products/dto/adjust-stock.dto.ts` | `{ delta }` validation | 2 |
| `src/modules/products/admin-products.controller.ts` | `POST :id/stock-adjustments` | 2 |
| `src/modules/cart/*` | cart service (lock, set, remove, clear), DTOs, controller | 3 |
| `src/modules/orders/orders.service.ts` | caller-scoped reads, cancel | 4, 6 |
| `src/modules/orders/checkout.service.ts` | the checkout transaction | 5 |
| `src/common/pipes/idempotency-key.pipe.ts` | header format validation | 5 |
| `test/helpers/assert-stock-conserved.ts` | the conservation invariant | 7 |
| `test/checkout-concurrency.e2e-spec.ts` | C1–C8 | 7 |
| `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md` | documentation | 8 |

## Task dependency order

```
1 (schema+factories)
├── 2 (stock methods + admin route)
├── 3 (cart)          ← also proves the parallel-request harness (§C7)
└── 4 (order reads)
        └── 5 (checkout)  [needs 2, 3, 4]
                └── 6 (cancel)
                        └── 7 (concurrency suite + negative controls)  [needs 5, 6]
                                └── 8 (docs)
```

**Hard orderings that break silently:**
- Task 1's migration SQL is hand-edited **before it is ever applied**. Once applied or merged it is frozen.
- Task 7 cannot start before 5 and 6: a negative control needs a real implementation to revert to.
- Task 3 must prove `await app.listen(0)` before task 7 depends on it.

### Coverage type per task

| Task | Unit | Deterministic e2e | Concurrency e2e |
|---|---|---|---|
| 1 | — | factories | — |
| 2 | `ProductsService` stock methods | admin stock route matrix | — |
| 3 | `CartService` | cart routes + harness proof | — |
| 4 | — | order reads, caller scoping | — |
| 5 | `CheckoutService` | checkout + idempotency + snapshot | — |
| 6 | `OrdersService.cancel` | cancel semantics | — |
| 7 | — | — | **C1–C8 + negative controls** |
| 8 | — | — | — |

### Tasks that touch Prisma schema or migrations

**Task 1 only.** No later task edits `prisma/schema.prisma` or any file under `prisma/migrations/`. If a later task appears to need a schema change, stop and report it rather than adding a second migration.

---

## Task 1: Schema, migration, and factories

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_phase3_cart_orders_stock/migration.sql` (generated, then edited)
- Modify: `test/factories/product.factory.ts`
- Create: `test/factories/cart.factory.ts`, `test/factories/order.factory.ts`
- Test: `test/factories.e2e-spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma models `Cart`, `CartItem`, `Order`, `OrderItem`, enum `OrderStatus { PENDING, CANCELLED }`, field `Product.stockQuantity: number`; factories `createCart(prisma, userId): Promise<Cart>`, `createCartItem(prisma, cartId, productId, quantity): Promise<CartItem>`, `createOrder(prisma, userId, lines, overrides?): Promise<OrderWithItems>`.

- [ ] **Step 1: Add `stockQuantity` to `Product`**

In `prisma/schema.prisma`, inside `model Product`, directly after `currency`:

```prisma
  stockQuantity Int      @default(0) @map("stock_quantity")
```

- [ ] **Step 2: Add the four new models and the enum**

Append to `prisma/schema.prisma`:

```prisma
enum OrderStatus {
  PENDING
  CANCELLED
}

model Cart {
  id        String     @id @default(uuid(7))
  userId    String     @unique @map("user_id")
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  items     CartItem[]
  createdAt DateTime   @default(now()) @map("created_at")
  updatedAt DateTime   @updatedAt @map("updated_at")

  @@map("carts")
}

model CartItem {
  id        String   @id @default(uuid(7))
  cartId    String   @map("cart_id")
  cart      Cart     @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productId String   @map("product_id")
  product   Product  @relation(fields: [productId], references: [id], onDelete: Restrict)
  quantity  Int
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([cartId, productId])
  @@index([productId])
  @@map("cart_items")
}

model Order {
  id             String      @id @default(uuid(7))
  userId         String      @map("user_id")
  user           User        @relation(fields: [userId], references: [id], onDelete: Restrict)
  status         OrderStatus @default(PENDING)
  totalCents     Int         @map("total_cents")
  currency       String
  idempotencyKey String      @map("idempotency_key")
  cancelledAt    DateTime?   @map("cancelled_at")
  items          OrderItem[]
  createdAt      DateTime    @default(now()) @map("created_at")
  updatedAt      DateTime    @updatedAt @map("updated_at")

  @@unique([userId, idempotencyKey])
  @@index([userId, createdAt])
  @@map("orders")
}

model OrderItem {
  id             String   @id @default(uuid(7))
  orderId        String   @map("order_id")
  order          Order    @relation(fields: [orderId], references: [id], onDelete: Cascade)
  productId      String   @map("product_id")
  product        Product  @relation(fields: [productId], references: [id], onDelete: Restrict)
  productName    String   @map("product_name")
  unitPriceCents Int      @map("unit_price_cents")
  quantity       Int
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  @@unique([orderId, productId])
  @@index([productId])
  @@map("order_items")
}
```

Also add the back-relations Prisma requires, or `prisma validate` fails:
- in `model User`: `cart Cart?` and `orders Order[]`
- in `model Product`: `cartItems CartItem[]` and `orderItems OrderItem[]`

- [ ] **Step 3: Generate the migration WITHOUT applying it**

```bash
docker compose up -d postgres
npx prisma migrate dev --create-only --name phase3_cart_orders_stock
```

Expected: a new folder under `prisma/migrations/` containing `migration.sql`. The database is **not** yet changed.

- [ ] **Step 4: Hand-edit the migration to add CHECK constraints**

Prisma's schema language cannot express CHECK constraints, so append these to the **end** of the generated `migration.sql`. This is the only moment it is legal to edit this file (CLAUDE.md: migrations are frozen once applied or merged).

```sql
-- Phase 3: invariants the application also enforces (spec §4.1, §4.3, §4.5).
-- These are backstops. If one ever fires it means a code path bypassed the
-- service layer, so the resulting 500 is intentional and must stay loud.
ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_quantity_non_negative" CHECK ("stock_quantity" >= 0);

ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_unit_price_non_negative" CHECK ("unit_price_cents" >= 0);
```

- [ ] **Step 5: Apply the migration and regenerate the client**

```bash
npx prisma migrate dev
npm run prisma:generate
```

Expected: migration applies cleanly; `stockQuantity` and the new models appear in the generated types.

- [ ] **Step 6: Verify the CHECK constraint actually exists**

```bash
docker compose exec postgres psql -U postgres -d ecommerce_dev -c "\d+ products" | grep -i check
```

Expected: `products_stock_quantity_non_negative` is listed. If it is missing, the edit in Step 4 landed after Prisma had already applied the file — do **not** edit it now; create a follow-up migration and report it.

- [ ] **Step 7: Give `createProduct` a stock default**

In `test/factories/product.factory.ts`, inside the `data` object, after `currency: 'USD',`:

```ts
      // Phase 3: factory products are sellable by default. Tests that care
      // about stock pass an explicit override.
      stockQuantity: 100,
```

- [ ] **Step 8: Write the cart factory**

Create `test/factories/cart.factory.ts`:

```ts
import { Cart, CartItem } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * Inserts through the Prisma client, never $executeRaw: ids use
 * `@default(uuid(7))`, which Prisma generates client-side, so a raw insert
 * would produce a row with no id.
 */
export async function createCart(
  prisma: PrismaService,
  userId: string,
): Promise<Cart> {
  return prisma.cart.create({ data: { userId } });
}

export async function createCartItem(
  prisma: PrismaService,
  cartId: string,
  productId: string,
  quantity = 1,
): Promise<CartItem> {
  return prisma.cartItem.create({ data: { cartId, productId, quantity } });
}
```

- [ ] **Step 9: Write the order factory**

Create `test/factories/order.factory.ts`:

```ts
import { Order, OrderItem, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/** Same serial-suite caveat as the other factories. */
let sequence = 0;

export interface OrderLineInput {
  productId: string;
  productName: string;
  unitPriceCents: number;
  quantity: number;
}

export type OrderWithItems = Order & { items: OrderItem[] };

/**
 * Builds an order directly, bypassing checkout. Use it for read/cancel
 * tests; never use it to assert anything about stock, because it does NOT
 * decrement stock the way checkout does.
 */
export async function createOrder(
  prisma: PrismaService,
  userId: string,
  lines: OrderLineInput[],
  overrides: Partial<Prisma.OrderUncheckedCreateInput> = {},
): Promise<OrderWithItems> {
  sequence += 1;

  const totalCents = lines.reduce(
    (sum, line) => sum + line.unitPriceCents * line.quantity,
    0,
  );

  return prisma.order.create({
    data: {
      userId,
      status: OrderStatus.PENDING,
      totalCents,
      currency: 'USD',
      idempotencyKey: `factory-key-${sequence}`,
      ...overrides,
      items: { create: lines },
    },
    include: { items: true },
  });
}
```

- [ ] **Step 10: Write the failing factory tests**

Append to `test/factories.e2e-spec.ts`, inside the existing top-level `describe`. Match the file's existing setup style (it already has `prisma`, `truncateAll`, and user/category/product factories imported):

```ts
  describe('cart and order factories', () => {
    it('creates a cart with items and an order with snapshot lines', async () => {
      const user = await createUser(prisma);
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 7,
      });

      const cart = await createCart(prisma, user.id);
      const item = await createCartItem(prisma, cart.id, product.id, 3);

      expect(cart.id).toHaveLength(36);
      expect(item.quantity).toBe(3);
      expect(product.stockQuantity).toBe(7);

      const order = await createOrder(prisma, user.id, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 2,
        },
      ]);

      expect(order.status).toBe('PENDING');
      expect(order.totalCents).toBe(product.priceCents * 2);
      expect(order.items).toHaveLength(1);
      expect(order.items[0].productName).toBe(product.name);
    });

    it('defaults stockQuantity to 100 and honours an override', async () => {
      const category = await createCategory(prisma);
      const stocked = await createProduct(prisma, category.id);
      const empty = await createProduct(prisma, category.id, {
        stockQuantity: 0,
      });

      expect(stocked.stockQuantity).toBe(100);
      expect(empty.stockQuantity).toBe(0);
    });

    it('refuses to store negative stock (database CHECK constraint)', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 1,
      });

      await expect(
        prisma.product.update({
          where: { id: product.id },
          data: { stockQuantity: { decrement: 5 } },
        }),
      ).rejects.toThrow();
    });
  });
```

Add the imports at the top of the file:

```ts
import { createCart, createCartItem } from './factories/cart.factory';
import { createOrder } from './factories/order.factory';
```

- [ ] **Step 11: Run the e2e factory tests and watch them pass**

```bash
docker compose up -d postgres-test
npm run test:e2e -- factories
```

Expected: PASS. (These tests were written after the schema in Step 1–5 because a migration cannot be test-driven — the test needs the table to exist to fail for the right reason. The third test is the real assertion here: it proves the hand-edited CHECK constraint reached the database.)

- [ ] **Step 12: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

Expected: all green; existing 139 unit and 120 e2e tests still pass.

- [ ] **Step 13: Commit**

```bash
git add prisma/schema.prisma prisma/migrations test/factories test/factories.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add cart, order, and product stock models

Adds Cart, CartItem, Order, OrderItem, OrderStatus and Product.stockQuantity
in one migration, hand-edited before first application to add the CHECK
constraints Prisma's schema language cannot express.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 2: Stock methods and the admin stock-adjustment route

**Files:**
- Create: `src/modules/products/types/stock-refusal.ts`
- Create: `src/modules/products/dto/adjust-stock.dto.ts`
- Modify: `src/modules/products/products.service.ts`
- Modify: `src/modules/products/admin-products.controller.ts`
- Modify: `src/modules/products/dto/product-response.dto.ts`
- Test: `src/modules/products/products.service.spec.ts`, `test/admin-products.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's `stockQuantity`.
- Produces:
  - `type StockRefusal = 'missing' | 'inactive' | 'insufficient-stock'`
  - `ProductsService.decrementStock(tx: Prisma.TransactionClient, productId: string, quantity: number): Promise<number>` — returns the matched row count; `0` means refused.
  - `ProductsService.incrementStock(tx: Prisma.TransactionClient, productId: string, quantity: number): Promise<void>`
  - `ProductsService.describeRefusal(tx: Prisma.TransactionClient, productId: string): Promise<StockRefusal>`
  - `ProductsService.findManyForSnapshot(tx: Prisma.TransactionClient, productIds: string[]): Promise<ProductSnapshot[]>` where `ProductSnapshot = { id: string; name: string; priceCents: number; currency: string }`
  - `ProductsService.adjustStock(id: string, delta: number): Promise<ProductWithCategory>`
  - `ProductResponseDto.stockQuantity: number`

- [ ] **Step 1: Create the refusal type**

Create `src/modules/products/types/stock-refusal.ts`:

```ts
/**
 * Why a conditional stock decrement matched zero rows (spec §5.3.1).
 *
 * 'missing' and 'inactive' share ONE client-facing message; the distinction
 * exists for logs and tests. 'missing' is unreachable while CartItem's
 * product FK is onDelete: Restrict and products are only soft-deleted, so
 * seeing it means an invariant broke elsewhere.
 */
export type StockRefusal = 'missing' | 'inactive' | 'insufficient-stock';
```

- [ ] **Step 2: Write the failing unit tests for the stock methods**

Append to `src/modules/products/products.service.spec.ts`. Extend the existing `prisma` mock object with typed entries (a bare `jest.Mock` fails `lint:ci` — see Global Constraints):

```ts
  type UpdateManyArgs = [
    {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    },
  ];
  type FindUniqueArgs = [{ where: { id: string }; select?: unknown }];
  type FindManyArgs = [{ where: unknown; select?: unknown }];

  // Added to the existing `prisma` mock declaration:
  //   updateMany: jest.Mock<Promise<{ count: number }>, UpdateManyArgs>;
  //   findUnique: jest.Mock<Promise<unknown>, FindUniqueArgs>;
  // and in beforeEach:
  //   updateMany: jest.fn<Promise<{ count: number }>, UpdateManyArgs>()
  //     .mockResolvedValue({ count: 1 }),
  //   findUnique: jest.fn<Promise<unknown>, FindUniqueArgs>()
  //     .mockResolvedValue(null),

  describe('decrementStock', () => {
    it('puts isActive and the stock floor in the WHERE clause, not in JS', async () => {
      prisma.product.updateMany.mockResolvedValue({ count: 1 });

      const count = await service.decrementStock(
        prisma as unknown as Prisma.TransactionClient,
        'product-1',
        3,
      );

      expect(count).toBe(1);
      expect(prisma.product.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'product-1', isActive: true, stockQuantity: { gte: 3 } },
        data: { stockQuantity: { decrement: 3 } },
      });
    });

    it('returns 0 when the predicate refuses the write', async () => {
      prisma.product.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.decrementStock(
          prisma as unknown as Prisma.TransactionClient,
          'product-1',
          3,
        ),
      ).resolves.toBe(0);
    });
  });

  describe('incrementStock', () => {
    it('restores stock without an isActive predicate', async () => {
      await service.incrementStock(
        prisma as unknown as Prisma.TransactionClient,
        'product-1',
        2,
      );

      expect(prisma.product.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'product-1' },
        data: { stockQuantity: { increment: 2 } },
      });
    });
  });

  describe('describeRefusal', () => {
    it('reports a missing product', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.describeRefusal(
          prisma as unknown as Prisma.TransactionClient,
          'gone',
        ),
      ).resolves.toBe('missing');
    });

    it('reports an inactive product', async () => {
      prisma.product.findUnique.mockResolvedValue({ isActive: false });

      await expect(
        service.describeRefusal(
          prisma as unknown as Prisma.TransactionClient,
          'p1',
        ),
      ).resolves.toBe('inactive');
    });

    it('reports insufficient stock for an active product', async () => {
      prisma.product.findUnique.mockResolvedValue({ isActive: true });

      await expect(
        service.describeRefusal(
          prisma as unknown as Prisma.TransactionClient,
          'p1',
        ),
      ).resolves.toBe('insufficient-stock');
    });

    it('never throws, and reads through the transaction client it is given', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.describeRefusal(
          prisma as unknown as Prisma.TransactionClient,
          'gone',
        ),
      ).resolves.toBe('missing');
      expect(prisma.product.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('adjustStock', () => {
    it('refuses an adjustment that would go below zero', async () => {
      prisma.product.updateMany.mockResolvedValue({ count: 0 });
      prisma.product.findUnique.mockResolvedValue({ id: 'p1' });

      await expect(service.adjustStock('p1', -5)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.product.updateMany.mock.calls[0][0]).toEqual({
        where: { id: 'p1', stockQuantity: { gte: 5 } },
        data: { stockQuantity: { increment: -5 } },
      });
    });

    it('404s for an unknown id', async () => {
      prisma.product.updateMany.mockResolvedValue({ count: 0 });
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.adjustStock('nope', 5)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
```

Add to the file's imports: `ConflictException` from `@nestjs/common` and `Prisma` from `@prisma/client`.

- [ ] **Step 3: Run the unit tests and watch them fail**

```bash
npm test -- products.service
```

Expected: FAIL — `service.decrementStock is not a function`.

- [ ] **Step 4: Implement the stock methods**

In `src/modules/products/products.service.ts`, add the imports (`ConflictException`, and `StockRefusal` from `./types/stock-refusal`), the snapshot type, and these methods:

```ts
export interface ProductSnapshot {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
}
```

```ts
  /**
   * Claims `quantity` units. The check and the write are ONE statement: the
   * predicate travels with the write, exactly as RefreshTokenService.rotate()
   * claims a token. Do not "simplify" this into a read, a check, and an
   * update — two concurrent checkouts would both read the same stock, both
   * pass the check, and both write, and the oversell would be invisible.
   *
   * Returns the matched row count. 0 means refused; ask describeRefusal() why.
   * `tx` is required so this can never run outside the checkout transaction.
   */
  async decrementStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantity: number,
  ): Promise<number> {
    const { count } = await tx.product.updateMany({
      where: { id: productId, isActive: true, stockQuantity: { gte: quantity } },
      data: { stockQuantity: { decrement: quantity } },
    });

    return count;
  }

  /**
   * Restores stock on cancellation. Deliberately has no isActive predicate:
   * stock must return even to a product deactivated after the order was
   * placed. updateMany, not update, so a vanished product cannot turn a
   * cancellation into a 404.
   */
  async incrementStock(
    tx: Prisma.TransactionClient,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await tx.product.updateMany({
      where: { id: productId },
      data: { stockQuantity: { increment: quantity } },
    });
  }

  /**
   * Explains a refusal that already happened. Never authorises a sale, and is
   * never consulted before a decrement (spec §5.3.1).
   *
   * Takes no ProductVisibility: telling an absent product apart from an
   * inactive one is the whole job, so it must see the row either way. This is
   * also why findOne(id, 'all') is NOT used here — findOne throws
   * NotFoundException, which would surface as a misleading 404 on
   * POST /orders, and it queries this.prisma, so it would read outside the
   * caller's transaction.
   */
  async describeRefusal(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<StockRefusal> {
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { isActive: true },
    });

    if (!product) {
      return 'missing';
    }

    return product.isActive ? 'insufficient-stock' : 'inactive';
  }

  /**
   * Price/name snapshot source for checkout. Called only AFTER the caller
   * holds every one of these product row locks, so no concurrent price
   * update can land between this read and the order insert.
   */
  async findManyForSnapshot(
    tx: Prisma.TransactionClient,
    productIds: string[],
  ): Promise<ProductSnapshot[]> {
    return tx.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, priceCents: true, currency: true },
    });
  }

  /**
   * Relative restock, never an absolute set: an absolute write is a lost
   * update (an admin reads 10, a checkout commits 10 -> 9, the admin writes
   * 15, and that sale is erased). Same compare-and-swap as decrementStock, so
   * a reduction below zero returns 409 instead of reaching the CHECK
   * constraint.
   */
  async adjustStock(id: string, delta: number): Promise<ProductWithCategory> {
    const { count } = await this.prisma.product.updateMany({
      // For a positive delta this bound is negative and always true.
      where: { id, stockQuantity: { gte: -delta } },
      data: { stockQuantity: { increment: delta } },
    });

    if (count === 0) {
      const exists = await this.prisma.product.findUnique({
        where: { id },
        select: { id: true },
      });

      if (!exists) {
        throw new NotFoundException('Product not found');
      }

      throw new ConflictException('Insufficient stock for this adjustment');
    }

    return this.findOne(id, 'all');
  }
```

- [ ] **Step 5: Run the unit tests and watch them pass**

```bash
npm test -- products.service
```

Expected: PASS.

- [ ] **Step 6: Expose `stockQuantity` on the response DTO**

In `src/modules/products/dto/product-response.dto.ts`, after the `currency` property:

```ts
  // D10 (spec §4.1.1): the exact stock level is PUBLIC by decision, not by
  // accident of DTO reuse. Removing it from the public catalog is a product
  // decision, not a cleanup.
  @ApiProperty({ example: 42, description: 'Units available for sale' })
  stockQuantity!: number;
```

and in `from()`, after `dto.currency = product.currency;`:

```ts
    dto.stockQuantity = product.stockQuantity;
```

- [ ] **Step 7: Accept an initial stock on create**

In `src/modules/products/dto/create-product.dto.ts`, after `currency`:

```ts
  @ApiPropertyOptional({ example: 10, default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stockQuantity?: number;
```

In `src/modules/products/products.service.ts`, add `stockQuantity?: number;` to `CreateProductInput`. In `admin-products.controller.ts`'s `create()`, add to the service call: `stockQuantity: dto.stockQuantity ?? 0,`.

**Do not add `stockQuantity` to `UpdateProductDto`** (§C1) — restocking is the relative route below.

- [ ] **Step 8: Write the adjust-stock DTO**

Create `src/modules/products/dto/adjust-stock.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min, NotEquals } from 'class-validator';

export class AdjustStockDto {
  @ApiProperty({
    example: 25,
    description:
      'Signed change in units. Positive restocks, negative removes. ' +
      'Relative by design: an absolute set would silently erase concurrent sales.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(-1_000_000)
  @Max(1_000_000)
  @NotEquals(0)
  delta!: number;
}
```

- [ ] **Step 9: Write the failing e2e tests for the route**

Append to `test/admin-products.e2e-spec.ts`, following the file's existing helpers for admin/customer tokens:

```ts
  describe('POST /api/v1/admin/products/:id/stock-adjustments', () => {
    it('restocks relatively and returns the new level', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 5,
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 7 })
        .expect(200);

      expect(response.body.stockQuantity).toBe(12);
    });

    it('removes stock with a negative delta', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 5,
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: -5 })
        .expect(200);

      expect(response.body.stockQuantity).toBe(0);
    });

    it('409s rather than letting stock go negative', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 3,
      });

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: -4 })
        .expect(409);

      const unchanged = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(unchanged.stockQuantity).toBe(3);
    });

    it('restocks an inactive product', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 0,
        isActive: false,
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 4 })
        .expect(200);

      expect(response.body.stockQuantity).toBe(4);
      expect(response.body.isActive).toBe(false);
    });

    it('400s on a zero or non-integer delta', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 0 })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 1.5 })
        .expect(400);
    });

    it('404s for an unknown product', async () => {
      await request(app.getHttpServer())
        .post(
          '/api/v1/admin/products/0195f0a0-0000-7000-8000-0000000000ff/stock-adjustments',
        )
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 1 })
        .expect(404);
    });

    it('403s for a customer and 401s without a token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({ delta: 1 })
        .expect(403);

      await request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .send({ delta: 1 })
        .expect(401);
    });
  });
```

- [ ] **Step 10: Run the e2e tests and watch them fail**

```bash
npm run test:e2e -- admin-products
```

Expected: FAIL with 404 from the router — the route does not exist yet.

- [ ] **Step 11: Add the route**

In `src/modules/products/admin-products.controller.ts`, import `HttpCode`, `AdjustStockDto`, and add:

```ts
  @Post(':id/stock-adjustments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Adjust stock by a relative amount',
    description:
      'Applies a signed delta. Relative rather than absolute so a concurrent ' +
      'sale cannot be silently overwritten. Returns the product with its new ' +
      'stock level, which a relative operation makes otherwise unguessable.',
  })
  @ApiResponse({ status: 200, description: 'Adjusted' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 403,
    description: 'Authenticated but not an administrator',
  })
  @ApiResponse({ status: 404, description: 'No product with that id' })
  @ApiResponse({
    status: 409,
    description: 'The adjustment would take stock below zero',
  })
  async adjustStock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStockDto,
  ): Promise<ProductResponseDto> {
    return ProductResponseDto.from(
      await this.productsService.adjustStock(id, dto.delta),
    );
  }
```

- [ ] **Step 12: Run the e2e tests and watch them pass**

```bash
npm run test:e2e -- admin-products
```

Expected: PASS.

- [ ] **Step 13: Assert the public catalog exposes stock (D10)**

Append to `test/catalog.e2e-spec.ts`:

```ts
  it('publishes the exact stock level to unauthenticated callers (D10)', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 9,
    });

    const list = await request(app.getHttpServer())
      .get('/api/v1/products')
      .expect(200);
    expect(list.body.data[0].stockQuantity).toBe(9);

    const detail = await request(app.getHttpServer())
      .get(`/api/v1/products/${product.id}`)
      .expect(200);
    expect(detail.body.stockQuantity).toBe(9);
  });
```

- [ ] **Step 14: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 15: Commit**

```bash
git add src/modules/products test/admin-products.e2e-spec.ts test/catalog.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add stock methods and the admin stock-adjustment route

Stock changes go through one compare-and-swap family on ProductsService.
Restocking is relative, never an absolute set, so a concurrent sale cannot
be silently overwritten. describeRefusal explains a refused decrement without
throwing and without a visibility argument.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 3: Cart module

**Files:**
- Create: `src/modules/cart/cart.module.ts`, `cart.service.ts`, `cart.service.spec.ts`, `cart.controller.ts`, `dto/set-cart-item.dto.ts`, `dto/cart-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `test/cart.e2e-spec.ts`

**Interfaces:**
- Consumes: `ProductsService.findOne(id, visibility)` from Phase 2; Task 1's models.
- Produces:
  - `CartService.lockForUpdate(tx: Prisma.TransactionClient, userId: string): Promise<{ id: string }>`
  - `CartService.listItemsForCheckout(tx: Prisma.TransactionClient, cartId: string): Promise<CartItem[]>` — **sorted by `productId` ascending**
  - `CartService.clear(tx: Prisma.TransactionClient, cartId: string): Promise<void>`
  - `CartService.getForUser(userId: string): Promise<CartWithItems | null>`
  - `CartService.setItem(userId: string, productId: string, quantity: number): Promise<CartWithItems>`
  - `CartService.removeItem(userId: string, productId: string): Promise<void>`
  - `type CartWithItems = Prisma.CartGetPayload<{ include: { items: { include: { product: { include: { category: true } } } } } }>`
  - `CartModule` exports `CartService`.

- [ ] **Step 1: Write the failing unit tests**

Create `src/modules/cart/cart.service.spec.ts`:

```ts
import { UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CartService } from './cart.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

type UpsertArgs = [Record<string, unknown>];
type CountArgs = [{ where: Record<string, unknown> }];

describe('CartService', () => {
  let service: CartService;
  let prisma: {
    cart: {
      upsert: jest.Mock<Promise<{ id: string }>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
    };
    cartItem: {
      upsert: jest.Mock<Promise<unknown>, UpsertArgs>;
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      findMany: jest.Mock<Promise<unknown[]>, [unknown]>;
      count: jest.Mock<Promise<number>, CountArgs>;
      deleteMany: jest.Mock<Promise<{ count: number }>, [unknown]>;
    };
    $transaction: jest.Mock<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>;
  };
  let products: { findOne: jest.Mock<Promise<unknown>, [string, string]> };

  beforeEach(() => {
    prisma = {
      cart: {
        upsert: jest
          .fn<Promise<{ id: string }>, UpsertArgs>()
          .mockResolvedValue({ id: 'cart-1' }),
        findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
      },
      cartItem: {
        upsert: jest.fn<Promise<unknown>, UpsertArgs>().mockResolvedValue({}),
        findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
        findMany: jest.fn<Promise<unknown[]>, [unknown]>().mockResolvedValue([]),
        count: jest.fn<Promise<number>, CountArgs>().mockResolvedValue(0),
        deleteMany: jest
          .fn<Promise<{ count: number }>, [unknown]>()
          .mockResolvedValue({ count: 1 }),
      },
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>()
        .mockImplementation((callback) => callback(prisma)),
    };
    products = {
      findOne: jest.fn<Promise<unknown>, [string, string]>().mockResolvedValue({
        id: 'product-1',
      }),
    };

    service = new CartService(
      prisma as unknown as PrismaService,
      products as unknown as ProductsService,
    );
  });

  it('takes the cart row lock before touching any item', async () => {
    const order: string[] = [];
    prisma.cart.upsert.mockImplementation(async () => {
      order.push('lock');
      return { id: 'cart-1' };
    });
    prisma.cartItem.upsert.mockImplementation(async () => {
      order.push('item');
      return {};
    });
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 2);

    expect(order).toEqual(['lock', 'item']);
  });

  it('writes an absolute quantity and never an increment (D11)', async () => {
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 2);

    const args = prisma.cartItem.upsert.mock.calls[0][0] as {
      update: { quantity: number };
      create: { quantity: number };
    };
    expect(args.update).toEqual({ quantity: 2 });
    expect(args.create).toMatchObject({ quantity: 2 });
  });

  it('validates the product as active before writing', async () => {
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await service.setItem('user-1', 'product-1', 1);

    expect(products.findOne.mock.calls[0]).toEqual([
      'product-1',
      'active-only',
    ]);
  });

  it('rejects a 51st distinct line with 422', async () => {
    prisma.cartItem.findUnique.mockResolvedValue(null);
    prisma.cartItem.count.mockResolvedValue(50);

    await expect(
      service.setItem('user-1', 'product-51', 1),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(prisma.cartItem.upsert).not.toHaveBeenCalled();
  });

  it('allows updating an existing line when the cart is already at the cap', async () => {
    prisma.cartItem.findUnique.mockResolvedValue({ id: 'item-1' });
    prisma.cartItem.count.mockResolvedValue(50);
    prisma.cart.findUnique.mockResolvedValue({ id: 'cart-1', items: [] });

    await expect(
      service.setItem('user-1', 'product-1', 3),
    ).resolves.toBeDefined();
  });

  it('returns checkout items sorted by productId', async () => {
    await service.listItemsForCheckout(
      prisma as unknown as Prisma.TransactionClient,
      'cart-1',
    );

    expect(prisma.cartItem.findMany.mock.calls[0][0]).toEqual({
      where: { cartId: 'cart-1' },
      orderBy: { productId: 'asc' },
    });
  });
});
```

- [ ] **Step 2: Run the unit tests and watch them fail**

```bash
npm test -- cart.service
```

Expected: FAIL — module `./cart.service` not found.

- [ ] **Step 3: Implement `CartService`**

Create `src/modules/cart/cart.service.ts`:

```ts
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { CartItem, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

/** One cart may hold at most this many distinct products. */
const MAX_CART_LINES = 50;

export type CartWithItems = Prisma.CartGetPayload<{
  include: { items: { include: { product: { include: { category: true } } } } };
}>;

@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * Takes this user's cart row lock, creating the cart if it is the first
   * one. The `update` branch is what acquires the lock, held until commit:
   * every cart mutation and every checkout starts here, which is what stops
   * two concurrent checkouts from both consuming the same cart.
   *
   * The upsert also removes the first-cart creation race; Prisma compiles
   * this shape (single unique field, no nested writes) to a native
   * INSERT ... ON CONFLICT. Test C8 proves that rather than trusting it.
   */
  async lockForUpdate(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<{ id: string }> {
    return tx.cart.upsert({
      where: { userId },
      create: { userId },
      update: { updatedAt: new Date() },
      select: { id: true },
    });
  }

  /** Sorted by productId so every caller takes product locks in one order. */
  async listItemsForCheckout(
    tx: Prisma.TransactionClient,
    cartId: string,
  ): Promise<CartItem[]> {
    return tx.cartItem.findMany({
      where: { cartId },
      orderBy: { productId: 'asc' },
    });
  }

  async clear(tx: Prisma.TransactionClient, cartId: string): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
  }

  /** Never creates a cart: a read must not write. */
  async getForUser(userId: string): Promise<CartWithItems | null> {
    return this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: { product: { include: { category: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  }

  /**
   * SETS the quantity for one product (D11). Repeated calls are idempotent;
   * there is no increment path, so two of the user's own tabs cannot produce
   * a lost update.
   */
  async setItem(
    userId: string,
    productId: string,
    quantity: number,
  ): Promise<CartWithItems> {
    // 404s for unknown or inactive. Deliberately outside the lock: this is a
    // convenience check, and checkout's decrement predicate is the authority
    // if the product is deactivated in between.
    await this.productsService.findOne(productId, 'active-only');

    await this.prisma.$transaction(async (tx) => {
      const cart = await this.lockForUpdate(tx, userId);

      const existing = await tx.cartItem.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId } },
        select: { id: true },
      });

      if (!existing) {
        const lines = await tx.cartItem.count({ where: { cartId: cart.id } });

        if (lines >= MAX_CART_LINES) {
          throw new UnprocessableEntityException(
            `A cart may hold at most ${MAX_CART_LINES} products`,
          );
        }
      }

      await tx.cartItem.upsert({
        where: { cartId_productId: { cartId: cart.id, productId } },
        create: { cartId: cart.id, productId, quantity },
        update: { quantity },
      });
    });

    const cart = await this.getForUser(userId);

    // Unreachable: the transaction above created the cart if needed.
    if (!cart) {
      throw new UnprocessableEntityException('Cart could not be read');
    }

    return cart;
  }

  /** Idempotent: removing an absent line, or acting on a user with no cart,
   *  is a no-op rather than a 404. */
  async removeItem(userId: string, productId: string): Promise<void> {
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      select: { id: true },
    });

    if (!cart) {
      return;
    }

    await this.prisma.cartItem.deleteMany({
      where: { cartId: cart.id, productId },
    });
  }
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

```bash
npm test -- cart.service
```

Expected: PASS.

- [ ] **Step 5: Write the DTOs**

Create `src/modules/cart/dto/set-cart-item.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class SetCartItemDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: 99,
    description:
      'The quantity this line should have. This SETS the quantity; it does ' +
      'not add to it. Remove a line with DELETE, not with quantity 0.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}
```

Create `src/modules/cart/dto/cart-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ProductResponseDto } from '../../products/dto/product-response.dto';
import { CartWithItems } from '../cart.service';

export class CartItemResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ type: ProductResponseDto })
  product!: ProductResponseDto;

  @ApiProperty({
    example: 9998,
    description:
      'Live price x quantity, in minor units. Indicative only: the binding ' +
      'price is snapshotted at checkout.',
  })
  lineTotalCents!: number;
}

export class CartResponseDto {
  @ApiProperty({ type: [CartItemResponseDto] })
  items!: CartItemResponseDto[];

  @ApiProperty({ example: 9998, description: 'Indicative total, minor units' })
  totalCents!: number;

  static from(cart: CartWithItems | null): CartResponseDto {
    const dto = new CartResponseDto();

    dto.items = (cart?.items ?? []).map((item) => {
      const line = new CartItemResponseDto();

      line.id = item.id;
      line.quantity = item.quantity;
      line.product = ProductResponseDto.from(item.product);
      line.lineTotalCents = item.product.priceCents * item.quantity;

      return line;
    });

    dto.totalCents = dto.items.reduce(
      (sum, item) => sum + item.lineTotalCents,
      0,
    );

    return dto;
  }
}
```

- [ ] **Step 6: Write the controller and module**

Create `src/modules/cart/cart.controller.ts`:

```ts
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CartService } from './cart.service';
import { SetCartItemDto } from './dto/set-cart-item.dto';
import { CartResponseDto } from './dto/cart-response.dto';

@ApiTags('cart')
@ApiBearerAuth()
@Controller('cart')
export class CartController {
  constructor(private readonly cartService: CartService) {}

  // request.user is guaranteed by the global JwtAuthGuard; none of these
  // routes is @Public().
  @Get()
  @ApiOperation({
    summary: "Read the caller's cart",
    description: 'Does not create a cart. An absent cart reads as empty.',
  })
  @ApiResponse({ status: 200, description: 'The cart' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async get(@Req() request: Request): Promise<CartResponseDto> {
    return CartResponseDto.from(
      await this.cartService.getForUser(request.user!.sub),
    );
  }

  @Put('items/:productId')
  @ApiOperation({
    summary: 'Set the quantity of one product in the cart',
    description:
      'Assigns the quantity; it does not add to the existing line. ' +
      'Repeating the same request leaves the same state.',
  })
  @ApiResponse({ status: 200, description: 'The updated cart' })
  @ApiResponse({ status: 400, description: 'Quantity outside 1-99' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({ status: 404, description: 'No such active product' })
  @ApiResponse({ status: 422, description: 'Cart line limit reached' })
  async setItem(
    @Req() request: Request,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetCartItemDto,
  ): Promise<CartResponseDto> {
    return CartResponseDto.from(
      await this.cartService.setItem(
        request.user!.sub,
        productId,
        dto.quantity,
      ),
    );
  }

  @Delete('items/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove one product from the cart',
    description: 'Idempotent: removing an absent line also returns 204.',
  })
  @ApiResponse({ status: 204, description: 'Removed' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async removeItem(
    @Req() request: Request,
    @Param('productId', ParseUUIDPipe) productId: string,
  ): Promise<void> {
    await this.cartService.removeItem(request.user!.sub, productId);
  }
}
```

Create `src/modules/cart/cart.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
```

In `src/app.module.ts`, import `CartModule` and add it to `imports` after `ProductsModule`. **Do not touch the `providers` array** — guard registration order is fixed.

- [ ] **Step 7: Write the failing cart e2e tests**

Create `test/cart.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

describe('Cart (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
    const user = await createUser(prisma);
    userId = user.id;
    token = await tokens.signAccessToken(user);
  });

  const auth = (): string => `Bearer ${token}`;

  it('reads an empty cart without creating a row', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', auth())
      .expect(200);

    expect(response.body).toEqual({ items: [], totalCents: 0 });
    expect(await prisma.cart.count()).toBe(0);
  });

  it('SETS the quantity rather than accumulating it (D11)', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity: 2 })
        .expect(200);
    }

    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', auth())
      .expect(200);

    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].quantity).toBe(2);
    expect(response.body.totalCents).toBe(product.priceCents * 2);
  });

  it('rejects quantity 0 and 100 with 400', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (const quantity of [0, 100]) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity })
        .expect(400);
    }
  });

  it('404s for an unknown or inactive product', async () => {
    const category = await createCategory(prisma);
    const inactive = await createProduct(prisma, category.id, {
      isActive: false,
    });

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${inactive.id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(404);

    await request(app.getHttpServer())
      .put('/api/v1/cart/items/0195f0a0-0000-7000-8000-0000000000ff')
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(404);
  });

  it('422s on the 51st distinct line', async () => {
    const category = await createCategory(prisma);
    const products = [];

    for (let index = 0; index < 51; index += 1) {
      products.push(await createProduct(prisma, category.id));
    }

    for (const product of products.slice(0, 50)) {
      await request(app.getHttpServer())
        .put(`/api/v1/cart/items/${product.id}`)
        .set('Authorization', auth())
        .send({ quantity: 1 })
        .expect(200);
    }

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${products[50].id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(422);
  });

  it('removes a line idempotently', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .send({ quantity: 1 })
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .expect(204);

    await request(app.getHttpServer())
      .delete(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .expect(204);

    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('keeps carts private to their owner', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const other = await createUser(prisma);
    const otherToken = await tokens.signAccessToken(other);

    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', auth())
      .send({ quantity: 4 })
      .expect(200);

    const response = await request(app.getHttpServer())
      .get('/api/v1/cart')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);

    expect(response.body.items).toEqual([]);
    expect(userId).not.toBe(other.id);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer()).get('/api/v1/cart').expect(401);
  });
});
```

- [ ] **Step 8: Run the cart e2e tests**

```bash
npm run test:e2e -- cart
```

Expected: PASS.

- [ ] **Step 9: Prove the parallel-request harness (§C7) before task 7 depends on it**

Append to `test/cart.e2e-spec.ts`:

```ts
  describe('parallel request harness', () => {
    // Existing suites hand supertest an unlistened server, which makes
    // supertest call listen(0) itself per request. That is safe sequentially
    // and breaks under Promise.all. Concurrency suites must listen first.
    it('serves 10 simultaneous requests from one listening server', async () => {
      await app.listen(0);

      try {
        const responses = await Promise.all(
          Array.from({ length: 10 }, () =>
            request(app.getHttpServer())
              .get('/api/v1/cart')
              .set('Authorization', auth()),
          ),
        );

        expect(responses.map((response) => response.status)).toEqual(
          Array.from({ length: 10 }, () => 200),
        );
      } finally {
        await app.getHttpServer().close();
      }
    });
  });
```

Run it:

```bash
npm run test:e2e -- cart
```

Expected: PASS. **If this fails, stop and report** — task 7's whole suite depends on this harness shape.

- [ ] **Step 10: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 11: Commit**

```bash
git add src/modules/cart src/app.module.ts test/cart.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add the cart module

PUT sets a line's quantity and is idempotent; there is no incrementing add
path. Every mutation takes the per-user cart row lock, which is what later
serialises concurrent checkouts.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 4: Order reads

**Files:**
- Create: `src/modules/orders/orders.module.ts`, `orders.service.ts`, `orders.controller.ts`, `dto/order-response.dto.ts`
- Modify: `src/app.module.ts`
- Test: `test/orders.e2e-spec.ts`

**Interfaces:**
- Consumes: Task 1's `Order`/`OrderItem`; `PaginationQueryDto` and `PaginatedDto` from `src/common/dto/`.
- Produces:
  - `type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: true } }>`
  - `OrdersService.listForUser(userId: string, query: PaginationQueryDto): Promise<{ items: OrderWithItems[]; total: number }>`
  - `OrdersService.findOneForUser(userId: string, orderId: string): Promise<OrderWithItems>` — throws `NotFoundException` for an unknown **or** someone else's order
  - `OrderResponseDto.from(order: OrderWithItems): OrderResponseDto`
  - `OrdersModule` (exports nothing yet; task 5 adds `CheckoutService`)

- [ ] **Step 1: Write the response DTO**

Create `src/modules/orders/dto/order-response.dto.ts`:

```ts
import { ApiProperty } from '@nestjs/swagger';
import { OrderStatus, Prisma } from '@prisma/client';

export type OrderWithItems = Prisma.OrderGetPayload<{
  include: { items: true };
}>;

export class OrderItemResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000001' })
  productId!: string;

  @ApiProperty({
    example: 'Desk Lamp',
    description: 'The name as it was at checkout, never refreshed',
  })
  productName!: string;

  @ApiProperty({ example: 4999, description: 'Snapshot price, minor units' })
  unitPriceCents!: number;

  @ApiProperty({ example: 2 })
  quantity!: number;

  @ApiProperty({ example: 9998, description: 'Minor units' })
  lineTotalCents!: number;
}

export class OrderResponseDto {
  @ApiProperty({ example: '0195f0a0-0000-7000-8000-000000000000' })
  id!: string;

  @ApiProperty({ enum: OrderStatus, example: OrderStatus.PENDING })
  status!: OrderStatus;

  @ApiProperty({ example: 9998, description: 'Minor units' })
  totalCents!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ type: [OrderItemResponseDto] })
  items!: OrderItemResponseDto[];

  @ApiProperty({ nullable: true, example: null })
  cancelledAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;

  static from(order: OrderWithItems): OrderResponseDto {
    const dto = new OrderResponseDto();

    dto.id = order.id;
    dto.status = order.status;
    dto.totalCents = order.totalCents;
    dto.currency = order.currency;
    dto.cancelledAt = order.cancelledAt;
    dto.createdAt = order.createdAt;
    dto.items = order.items.map((item) => {
      const line = new OrderItemResponseDto();

      line.id = item.id;
      line.productId = item.productId;
      line.productName = item.productName;
      line.unitPriceCents = item.unitPriceCents;
      line.quantity = item.quantity;
      line.lineTotalCents = item.unitPriceCents * item.quantity;

      return line;
    });

    return dto;
  }
}
```

The `idempotencyKey` is deliberately **not** exposed: it is a client-supplied request token, not order data.

- [ ] **Step 2: Implement the read methods**

Create `src/modules/orders/orders.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { OrderWithItems } from './dto/order-response.dto';

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Always scoped to one user; there is no unscoped list route. */
  async listForUser(
    userId: string,
    query: PaginationQueryDto,
  ): Promise<{ items: OrderWithItems[]; total: number }> {
    const where = { userId };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        skip: query.skip,
        take: query.limit,
        orderBy: { createdAt: 'desc' },
        include: { items: true },
      }),
      this.prisma.order.count({ where }),
    ]);

    return { items, total };
  }

  /** Another user's order is 404, not 403: existence must not leak. */
  async findOneForUser(
    userId: string,
    orderId: string,
  ): Promise<OrderWithItems> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return order;
  }
}
```

- [ ] **Step 3: Write the controller and module**

Create `src/modules/orders/orders.controller.ts`:

```ts
import { Controller, Get, Param, ParseUUIDPipe, Query, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { OrdersService } from './orders.service';
import { OrderResponseDto } from './dto/order-response.dto';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { PaginatedDto } from '../../common/dto/paginated.dto';
import { ApiPaginatedResponse } from '../../common/swagger/api-paginated-response.decorator';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Get()
  @ApiOperation({
    summary: "List the caller's orders",
    description: 'Newest first. Only ever the authenticated caller\'s orders.',
  })
  @ApiPaginatedResponse(OrderResponseDto)
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  async list(
    @Req() request: Request,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedDto<OrderResponseDto>> {
    const { items, total } = await this.ordersService.listForUser(
      request.user!.sub,
      query,
    );

    return PaginatedDto.from(items.map(OrderResponseDto.from), total, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read one of the caller\'s orders' })
  @ApiResponse({ status: 200, description: 'The order' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: "No such order, or it belongs to another user",
  })
  async findOne(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.from(
      await this.ordersService.findOneForUser(request.user!.sub, id),
    );
  }
}
```

Create `src/modules/orders/orders.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { CartModule } from '../cart/cart.module';
import { ProductsModule } from '../products/products.module';

@Module({
  imports: [ProductsModule, CartModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
```

Register `OrdersModule` in `src/app.module.ts` after `CartModule`. Again, **do not touch `providers`**.

- [ ] **Step 4: Write the read e2e tests**

Create `test/orders.e2e-spec.ts` with the same setup block as `test/cart.e2e-spec.ts` (createTestApp with `throttleLimit: 0`, `truncateAll`, a user and token per test), plus:

```ts
  it('lists only the caller\'s orders, newest first', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const stranger = await createUser(prisma);

    const first = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);
    const second = await createOrder(prisma, userId, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 2,
      },
    ]);
    await createOrder(prisma, stranger.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);

    const response = await request(app.getHttpServer())
      .get('/api/v1/orders')
      .set('Authorization', auth())
      .expect(200);

    expect(response.body.meta.total).toBe(2);
    expect(response.body.data.map((order: { id: string }) => order.id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(response.body.data[0].items[0].lineTotalCents).toBe(
      product.priceCents * 2,
    );
  });

  it('paginates', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);

    for (let index = 0; index < 3; index += 1) {
      await createOrder(prisma, userId, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ]);
    }

    const response = await request(app.getHttpServer())
      .get('/api/v1/orders?page=2&limit=2')
      .set('Authorization', auth())
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta).toMatchObject({
      page: 2,
      limit: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it('404s on another user\'s order, and 401s without a token', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id);
    const stranger = await createUser(prisma);
    const theirs = await createOrder(prisma, stranger.id, [
      {
        productId: product.id,
        productName: product.name,
        unitPriceCents: product.priceCents,
        quantity: 1,
      },
    ]);

    await request(app.getHttpServer())
      .get(`/api/v1/orders/${theirs.id}`)
      .set('Authorization', auth())
      .expect(404);

    await request(app.getHttpServer())
      .get(`/api/v1/orders/${theirs.id}`)
      .expect(401);
  });
```

- [ ] **Step 5: Run the order read tests**

```bash
npm run test:e2e -- orders
```

Expected: PASS.

- [ ] **Step 6: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 7: Commit**

```bash
git add src/modules/orders src/app.module.ts test/orders.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add caller-scoped order read routes

Orders are always scoped to the authenticated caller; another user's order
returns 404 rather than 403 so existence does not leak.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 5: Checkout

**Files:**
- Create: `src/common/pipes/idempotency-key.pipe.ts`, `src/modules/orders/checkout.service.ts`, `src/modules/orders/checkout.service.spec.ts`
- Modify: `src/modules/orders/orders.controller.ts`, `src/modules/orders/orders.module.ts`
- Test: `test/checkout.e2e-spec.ts`

**Interfaces:**
- Consumes: `CartService.lockForUpdate/listItemsForCheckout/clear`, `ProductsService.decrementStock/describeRefusal/findManyForSnapshot`.
- Produces: `CheckoutService.checkout(userId: string, idempotencyKey: string): Promise<{ order: OrderWithItems; replayed: boolean }>`; `IdempotencyKeyPipe`.

- [ ] **Step 1: Write the idempotency key pipe**

Create `src/common/pipes/idempotency-key.pipe.ts`:

```ts
import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Validates the Idempotency-Key header. A header cannot be validated by a
 * body DTO, so this pipe is the trust boundary for it.
 */
@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
      throw new BadRequestException(
        'Idempotency-Key header must be 8-128 characters of A-Z, a-z, 0-9, _ or -',
      );
    }

    return value;
  }
}
```

- [ ] **Step 2: Write the failing checkout unit tests**

Create `src/modules/orders/checkout.service.spec.ts`:

```ts
import {
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CheckoutService } from './checkout.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';

type DecrementArgs = [unknown, string, number];

describe('CheckoutService', () => {
  let service: CheckoutService;
  let prisma: {
    order: {
      findUnique: jest.Mock<Promise<unknown>, [unknown]>;
      create: jest.Mock<Promise<unknown>, [unknown]>;
    };
    $transaction: jest.Mock<
      Promise<unknown>,
      [(tx: unknown) => Promise<unknown>, unknown?]
    >;
  };
  let cart: {
    lockForUpdate: jest.Mock<Promise<{ id: string }>, [unknown, string]>;
    listItemsForCheckout: jest.Mock<Promise<unknown[]>, [unknown, string]>;
    clear: jest.Mock<Promise<void>, [unknown, string]>;
  };
  let products: {
    decrementStock: jest.Mock<Promise<number>, DecrementArgs>;
    describeRefusal: jest.Mock<Promise<string>, [unknown, string]>;
    findManyForSnapshot: jest.Mock<Promise<unknown[]>, [unknown, string[]]>;
  };

  const line = (productId: string, quantity = 1) => ({
    id: `item-${productId}`,
    productId,
    quantity,
  });

  const snapshot = (id: string, priceCents = 1000, currency = 'USD') => ({
    id,
    name: `Product ${id}`,
    priceCents,
    currency,
  });

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
        create: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ id: 'order-1', items: [] }),
      },
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>, unknown?]>()
        .mockImplementation((callback) => callback(prisma)),
    };
    cart = {
      lockForUpdate: jest
        .fn<Promise<{ id: string }>, [unknown, string]>()
        .mockResolvedValue({ id: 'cart-1' }),
      listItemsForCheckout: jest
        .fn<Promise<unknown[]>, [unknown, string]>()
        .mockResolvedValue([line('b'), line('a')]),
      clear: jest.fn<Promise<void>, [unknown, string]>().mockResolvedValue(undefined),
    };
    products = {
      decrementStock: jest.fn<Promise<number>, DecrementArgs>().mockResolvedValue(1),
      describeRefusal: jest
        .fn<Promise<string>, [unknown, string]>()
        .mockResolvedValue('insufficient-stock'),
      findManyForSnapshot: jest
        .fn<Promise<unknown[]>, [unknown, string[]]>()
        .mockResolvedValue([snapshot('a'), snapshot('b')]),
    };

    service = new CheckoutService(
      prisma as unknown as PrismaService,
      cart as unknown as CartService,
      products as unknown as ProductsService,
    );
  });

  it('locks the cart, then replays a known key without decrementing anything', async () => {
    prisma.order.findUnique.mockResolvedValue({ id: 'existing', items: [] });

    const result = await service.checkout('user-1', 'key-abcdefgh');

    expect(result.replayed).toBe(true);
    expect(cart.lockForUpdate).toHaveBeenCalledTimes(1);
    expect(products.decrementStock).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('409s on an empty cart', async () => {
    cart.listItemsForCheckout.mockResolvedValue([]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('decrements in ascending productId order whatever order the cart returns', async () => {
    cart.listItemsForCheckout.mockResolvedValue([line('c'), line('a'), line('b')]);
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a'),
      snapshot('b'),
      snapshot('c'),
    ]);

    await service.checkout('user-1', 'key-abcdefgh');

    expect(
      products.decrementStock.mock.calls.map((call) => call[1]),
    ).toEqual(['a', 'b', 'c']);
  });

  it('maps a refused decrement to its 409 message', async () => {
    products.decrementStock.mockResolvedValue(0);
    products.describeRefusal.mockResolvedValue('insufficient-stock');

    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Insufficient stock',
    );

    products.describeRefusal.mockResolvedValue('inactive');
    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Product is no longer available',
    );

    products.describeRefusal.mockResolvedValue('missing');
    await expect(service.checkout('user-1', 'key-abcdefgh')).rejects.toThrow(
      'Product is no longer available',
    );
  });

  it('reads the price snapshot only after every decrement has succeeded', async () => {
    const calls: string[] = [];
    products.decrementStock.mockImplementation(async () => {
      calls.push('decrement');
      return 1;
    });
    products.findManyForSnapshot.mockImplementation(async () => {
      calls.push('snapshot');
      return [snapshot('a'), snapshot('b')];
    });

    await service.checkout('user-1', 'key-abcdefgh');

    expect(calls).toEqual(['decrement', 'decrement', 'snapshot']);
  });

  it('422s on a mixed-currency cart', async () => {
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a', 1000, 'USD'),
      snapshot('b', 1000, 'EUR'),
    ]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('422s when the total exceeds the INT column range', async () => {
    cart.listItemsForCheckout.mockResolvedValue([line('a', 99)]);
    products.findManyForSnapshot.mockResolvedValue([
      snapshot('a', 2_000_000_000),
    ]);

    await expect(
      service.checkout('user-1', 'key-abcdefgh'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('clears the cart after creating the order', async () => {
    await service.checkout('user-1', 'key-abcdefgh');

    expect(prisma.order.create).toHaveBeenCalledTimes(1);
    expect(cart.clear).toHaveBeenCalledWith(prisma, 'cart-1');
  });
});
```

- [ ] **Step 3: Run the unit tests and watch them fail**

```bash
npm test -- checkout.service
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `CheckoutService`**

Create `src/modules/orders/checkout.service.ts`:

```ts
import {
  ConflictException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CartService } from '../cart/cart.service';
import { ProductsService } from '../products/products.service';
import { OrderWithItems } from './dto/order-response.dto';

/** Postgres INT upper bound; totalCents is an INT column. */
const MAX_TOTAL_CENTS = 2_147_483_647;

// Prisma's defaults (2s / 5s) are tight for a body that waits on row locks
// while holding a pooled connection. Exceeding these raises P2028, which is
// deliberately unmapped: a logged 500 is the right signal for saturation.
const TX_MAX_WAIT_MS = 5_000;
const TX_TIMEOUT_MS = 10_000;

const UNAVAILABLE_MESSAGE = 'Product is no longer available';
const INSUFFICIENT_STOCK_MESSAGE = 'Insufficient stock';

export interface CheckoutResult {
  order: OrderWithItems;
  replayed: boolean;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cartService: CartService,
    private readonly productsService: ProductsService,
  ) {}

  /**
   * One transaction, in this order, for reasons recorded in spec §5.5:
   *
   *  1. lock the cart row       — serialises this user's checkouts
   *  2. look up the key         — INSIDE the lock, so a concurrent duplicate
   *                               sees the committed order instead of an
   *                               empty cart
   *  3. decrement stock         — sorted by productId; the predicate travels
   *                               with the write
   *  4. snapshot prices         — AFTER the locks are held
   *  5. create the order, clear the cart
   *
   * NO external I/O may ever be added inside this transaction: no HTTP call,
   * no token signing, no argon2. Phase 4's payment call happens after commit.
   */
  async checkout(
    userId: string,
    idempotencyKey: string,
  ): Promise<CheckoutResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const cart = await this.cartService.lockForUpdate(tx, userId);

        const existing = await tx.order.findUnique({
          where: { userId_idempotencyKey: { userId, idempotencyKey } },
          include: { items: true },
        });

        if (existing) {
          return { order: existing, replayed: true };
        }

        const items = await this.cartService.listItemsForCheckout(tx, cart.id);

        if (items.length === 0) {
          throw new ConflictException('Cart is empty');
        }

        for (const item of items) {
          const count = await this.productsService.decrementStock(
            tx,
            item.productId,
            item.quantity,
          );

          if (count === 0) {
            throw await this.refusalFor(tx, item.productId);
          }
        }

        const snapshots = await this.productsService.findManyForSnapshot(
          tx,
          items.map((item) => item.productId),
        );
        const byId = new Map(
          snapshots.map((snapshot) => [snapshot.id, snapshot]),
        );

        const currencies = new Set(
          snapshots.map((snapshot) => snapshot.currency),
        );

        if (currencies.size > 1) {
          throw new UnprocessableEntityException(
            'Cart contains products in more than one currency',
          );
        }

        let totalCents = 0;
        const lines = items.map((item) => {
          // Non-null: the decrement above matched this product's row.
          const product = byId.get(item.productId)!;

          totalCents += product.priceCents * item.quantity;

          return {
            productId: product.id,
            productName: product.name,
            unitPriceCents: product.priceCents,
            quantity: item.quantity,
          };
        });

        if (totalCents > MAX_TOTAL_CENTS) {
          throw new UnprocessableEntityException(
            'Order total exceeds the supported maximum',
          );
        }

        const order = await tx.order.create({
          data: {
            userId,
            idempotencyKey,
            totalCents,
            currency: [...currencies][0],
            items: { create: lines },
          },
          include: { items: true },
        });

        await this.cartService.clear(tx, cart.id);

        return { order, replayed: false };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: TX_MAX_WAIT_MS,
        timeout: TX_TIMEOUT_MS,
      },
    );
  }

  /** 'missing' and 'inactive' share one client message; only the logs differ. */
  private async refusalFor(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<ConflictException> {
    const refusal = await this.productsService.describeRefusal(tx, productId);

    if (refusal === 'missing') {
      this.logger.warn(
        `Cart referenced product ${productId}, which no longer exists`,
      );
    }

    return new ConflictException(
      refusal === 'insufficient-stock'
        ? INSUFFICIENT_STOCK_MESSAGE
        : UNAVAILABLE_MESSAGE,
    );
  }
}
```

- [ ] **Step 5: Run the unit tests and watch them pass**

```bash
npm test -- checkout.service
```

Expected: PASS.

- [ ] **Step 6: Add the route**

In `src/modules/orders/orders.module.ts`, add `CheckoutService` to `providers`.

In `src/modules/orders/orders.controller.ts`, add imports (`Headers`, `HttpStatus`, `Post`, `Res`, `ApiHeader`, `Response` from express, `CheckoutService`, `IdempotencyKeyPipe`), inject `CheckoutService`, and add:

```ts
  @Post()
  @ApiOperation({
    summary: "Check out the caller's cart",
    description:
      'Creates an order from the cart, decrementing stock atomically. ' +
      'Requires an Idempotency-Key header: replaying a key returns the ' +
      'original order with 200 instead of creating a second one.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: '8-128 characters of A-Z, a-z, 0-9, _ or -',
  })
  @ApiResponse({ status: 201, description: 'Order created' })
  @ApiResponse({ status: 200, description: 'Idempotency key replayed' })
  @ApiResponse({ status: 400, description: 'Missing or malformed key' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 409,
    description: 'Empty cart, insufficient stock, or unavailable product',
  })
  @ApiResponse({
    status: 422,
    description: 'Mixed currencies, or a total beyond the supported maximum',
  })
  async checkout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key', IdempotencyKeyPipe) idempotencyKey: string,
  ): Promise<OrderResponseDto> {
    const result = await this.checkoutService.checkout(
      request.user!.sub,
      idempotencyKey,
    );

    // The status varies, so it is set here rather than with @HttpCode. The
    // service never touches the response object.
    response.status(result.replayed ? HttpStatus.OK : HttpStatus.CREATED);

    return OrderResponseDto.from(result.order);
  }
```

- [ ] **Step 7: Write the checkout e2e tests**

Create `test/checkout.e2e-spec.ts` with the same setup block as `test/cart.e2e-spec.ts`, plus these helpers and tests:

```ts
  const addToCart = async (
    productId: string,
    quantity: number,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${productId}`)
      .set('Authorization', auth())
      .send({ quantity })
      .expect(200);
  };

  const checkout = (key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', auth())
      .set('Idempotency-Key', key);

  it('creates an order, decrements stock, and empties the cart', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
      priceCents: 2500,
    });
    await addToCart(product.id, 2);

    const response = await checkout('key-aaaaaaaa').expect(201);

    expect(response.body.status).toBe('PENDING');
    expect(response.body.totalCents).toBe(5000);
    expect(response.body.items[0]).toMatchObject({
      productName: product.name,
      unitPriceCents: 2500,
      quantity: 2,
      lineTotalCents: 5000,
    });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(8);
    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('409s on an empty cart', async () => {
    await checkout('key-bbbbbbbb').expect(409);
  });

  it('rolls back every decrement when one line cannot be satisfied', async () => {
    const category = await createCategory(prisma);
    const available = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const soldOut = await createProduct(prisma, category.id, {
      stockQuantity: 0,
    });
    await addToCart(available.id, 1);
    await addToCart(soldOut.id, 1);

    await checkout('key-cccccccc').expect(409);

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: available.id },
    });
    expect(unchanged.stockQuantity).toBe(10);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.cartItem.count()).toBe(2);
  });

  it('409s when a product is deactivated after it was added to the cart', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    await addToCart(product.id, 1);
    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });

    await checkout('key-dddddddd').expect(409);

    const unchanged = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(unchanged.stockQuantity).toBe(5);
  });

  it('422s on a mixed-currency cart', async () => {
    const category = await createCategory(prisma);
    const usd = await createProduct(prisma, category.id, { currency: 'USD' });
    const eur = await createProduct(prisma, category.id, { currency: 'EUR' });
    await addToCart(usd.id, 1);
    await addToCart(eur.id, 1);

    await checkout('key-eeeeeeee').expect(422);
    expect(await prisma.order.count()).toBe(0);
  });

  it('422s when the total would overflow the INT column', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      priceCents: 2_000_000_000,
      stockQuantity: 10,
    });
    await addToCart(product.id, 2);

    await checkout('key-ffffffff').expect(422);
  });

  it('replays a key instead of creating a second order', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    await addToCart(product.id, 1);

    const first = await checkout('key-gggggggg').expect(201);
    const replay = await checkout('key-gggggggg').expect(200);

    expect(replay.body.id).toBe(first.body.id);
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(9);
  });

  it('scopes keys to the user', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    await addToCart(product.id, 1);
    await checkout('key-hhhhhhhh').expect(201);

    const other = await createUser(prisma);
    const otherToken = await tokens.signAccessToken(other);
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${product.id}`)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ quantity: 1 })
      .expect(200);

    const theirs = await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', 'key-hhhhhhhh')
      .expect(201);

    expect(await prisma.order.count()).toBe(2);
    expect(theirs.body.items).toHaveLength(1);
  });

  it('400s on a missing or malformed Idempotency-Key', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', auth())
      .expect(400);

    await checkout('short').expect(400);
    await checkout('has spaces and symbols!!').expect(400);
  });

  it('keeps order lines immutable when the catalog changes afterwards', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
      priceCents: 1500,
      name: 'Original Name',
    });
    await addToCart(product.id, 2);

    const order = await checkout('key-iiiiiiii').expect(201);

    await prisma.product.update({
      where: { id: product.id },
      data: { priceCents: 9900, name: 'Renamed' },
    });

    const reread = await request(app.getHttpServer())
      .get(`/api/v1/orders/${order.body.id}`)
      .set('Authorization', auth())
      .expect(200);

    expect(reread.body.items[0]).toMatchObject({
      productName: 'Original Name',
      unitPriceCents: 1500,
      lineTotalCents: 3000,
    });
    expect(reread.body.totalCents).toBe(3000);
  });

  it('401s without a token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Idempotency-Key', 'key-jjjjjjjj')
      .expect(401);
  });
```

- [ ] **Step 8: Run the checkout e2e tests**

```bash
npm run test:e2e -- checkout
```

Expected: PASS.

- [ ] **Step 9: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 10: Commit**

```bash
git add src/common/pipes src/modules/orders test/checkout.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add transactional checkout with idempotent order creation

Checkout locks the cart row, replays the idempotency key inside that lock,
decrements stock with a conditional updateMany in sorted productId order,
snapshots prices only once every row lock is held, then creates the order and
clears the cart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 6: Cancellation

**Files:**
- Modify: `src/modules/orders/orders.service.ts`, `src/modules/orders/orders.controller.ts`
- Create: `src/modules/orders/orders.service.spec.ts`
- Test: `test/checkout.e2e-spec.ts` (append a `describe('cancellation')`)

**Interfaces:**
- Consumes: `ProductsService.incrementStock`.
- Produces: `OrdersService.cancel(userId: string, orderId: string): Promise<OrderWithItems>`. `OrdersService` now takes `ProductsService` as its second constructor argument.

- [ ] **Step 1: Write the failing unit tests**

Create `src/modules/orders/orders.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common';
import { OrderStatus } from '@prisma/client';
import { OrdersService } from './orders.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductsService } from '../products/products.service';

type UpdateManyArgs = [{ where: Record<string, unknown>; data: Record<string, unknown> }];

describe('OrdersService.cancel', () => {
  let service: OrdersService;
  let prisma: {
    order: {
      updateMany: jest.Mock<Promise<{ count: number }>, UpdateManyArgs>;
      findFirst: jest.Mock<Promise<unknown>, [unknown]>;
      findUniqueOrThrow: jest.Mock<Promise<unknown>, [unknown]>;
    };
    orderItem: { findMany: jest.Mock<Promise<unknown[]>, [unknown]> };
    $transaction: jest.Mock<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>;
  };
  let products: {
    incrementStock: jest.Mock<Promise<void>, [unknown, string, number]>;
  };

  beforeEach(() => {
    prisma = {
      order: {
        updateMany: jest
          .fn<Promise<{ count: number }>, UpdateManyArgs>()
          .mockResolvedValue({ count: 1 }),
        findFirst: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue(null),
        findUniqueOrThrow: jest
          .fn<Promise<unknown>, [unknown]>()
          .mockResolvedValue({ id: 'order-1', items: [] }),
      },
      orderItem: {
        findMany: jest
          .fn<Promise<unknown[]>, [unknown]>()
          .mockResolvedValue([
            { productId: 'a', quantity: 2 },
            { productId: 'b', quantity: 1 },
          ]),
      },
      $transaction: jest
        .fn<Promise<unknown>, [(tx: unknown) => Promise<unknown>]>()
        .mockImplementation((callback) => callback(prisma)),
    };
    products = {
      incrementStock: jest
        .fn<Promise<void>, [unknown, string, number]>()
        .mockResolvedValue(undefined),
    };

    service = new OrdersService(
      prisma as unknown as PrismaService,
      products as unknown as ProductsService,
    );
  });

  it('claims the order with a PENDING predicate in the WHERE clause', async () => {
    await service.cancel('user-1', 'order-1');

    expect(prisma.order.updateMany.mock.calls[0][0].where).toEqual({
      id: 'order-1',
      userId: 'user-1',
      status: OrderStatus.PENDING,
    });
  });

  it('restores stock in ascending productId order', async () => {
    await service.cancel('user-1', 'order-1');

    expect(products.incrementStock.mock.calls.map((call) => call[1])).toEqual([
      'a',
      'b',
    ]);
    expect(prisma.orderItem.findMany.mock.calls[0][0]).toMatchObject({
      orderBy: { productId: 'asc' },
    });
  });

  it('404s when the order does not exist or belongs to someone else', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findFirst.mockResolvedValue(null);

    await expect(service.cancel('user-1', 'order-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(products.incrementStock).not.toHaveBeenCalled();
  });

  it('is idempotent on an already-cancelled order and restores nothing twice', async () => {
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order-1',
      status: OrderStatus.CANCELLED,
      items: [],
    });

    await expect(service.cancel('user-1', 'order-1')).resolves.toMatchObject({
      id: 'order-1',
    });
    expect(products.incrementStock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
npm test -- orders.service
```

Expected: FAIL — `service.cancel is not a function`.

- [ ] **Step 3: Implement `cancel`**

In `src/modules/orders/orders.service.ts`, inject `ProductsService` and add:

```ts
  /**
   * The updateMany is a compare-and-swap: only the caller whose write matched
   * a PENDING row restores stock, so racing cancels restore EXACTLY ONCE.
   * Do not replace it with a read, a status check, and an update.
   */
  async cancel(userId: string, orderId: string): Promise<OrderWithItems> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.order.updateMany({
        where: { id: orderId, userId, status: OrderStatus.PENDING },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });

      if (count === 0) {
        const existing = await tx.order.findFirst({
          where: { id: orderId, userId },
          include: { items: true },
        });

        // Unknown, or another user's: both are 404, so existence never leaks.
        if (!existing) {
          throw new NotFoundException('Order not found');
        }

        // Already cancelled: idempotent, and stock is NOT restored again.
        return existing;
      }

      const items = await tx.orderItem.findMany({
        where: { orderId },
        orderBy: { productId: 'asc' },
      });

      for (const item of items) {
        await this.productsService.incrementStock(
          tx,
          item.productId,
          item.quantity,
        );
      }

      return tx.order.findUniqueOrThrow({
        where: { id: orderId },
        include: { items: true },
      });
    });
  }
```

Add the imports: `OrderStatus` from `@prisma/client`, `ProductsService` from `../products/products.service`.

- [ ] **Step 4: Run the unit tests and watch them pass**

```bash
npm test -- orders.service
```

- [ ] **Step 5: Add the route**

In `src/modules/orders/orders.controller.ts`:

```ts
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a pending order and return its stock',
    description:
      'Idempotent: cancelling an already-cancelled order returns it ' +
      'unchanged and does not restore stock a second time.',
  })
  @ApiResponse({ status: 200, description: 'The cancelled order' })
  @ApiResponse({ status: 401, description: 'Missing or invalid token' })
  @ApiResponse({
    status: 404,
    description: "No such order, or it belongs to another user",
  })
  async cancel(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OrderResponseDto> {
    return OrderResponseDto.from(
      await this.ordersService.cancel(request.user!.sub, id),
    );
  }
```

- [ ] **Step 6: Write the cancellation e2e tests**

Append to `test/checkout.e2e-spec.ts`:

```ts
  describe('cancellation', () => {
    it('restores stock and is idempotent', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 10,
      });
      await addToCart(product.id, 3);
      const order = await checkout('key-kkkkkkkk').expect(201);

      const midway = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(midway.stockQuantity).toBe(7);

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.body.id}/cancel`)
        .set('Authorization', auth())
        .expect(200);

      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.cancelledAt).not.toBeNull();

      const restored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(restored.stockQuantity).toBe(10);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.body.id}/cancel`)
        .set('Authorization', auth())
        .expect(200);

      const stillTen = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(stillTen.stockQuantity).toBe(10);
    });

    it('restores stock even for a product deactivated after the order', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 4,
      });
      await addToCart(product.id, 1);
      const order = await checkout('key-llllllll').expect(201);

      await prisma.product.update({
        where: { id: product.id },
        data: { isActive: false },
      });

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.body.id}/cancel`)
        .set('Authorization', auth())
        .expect(200);

      const restored = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(restored.stockQuantity).toBe(4);
    });

    it('404s on another user\'s order and 401s without a token', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id);
      const stranger = await createUser(prisma);
      const theirs = await createOrder(prisma, stranger.id, [
        {
          productId: product.id,
          productName: product.name,
          unitPriceCents: product.priceCents,
          quantity: 1,
        },
      ]);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${theirs.id}/cancel`)
        .set('Authorization', auth())
        .expect(404);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${theirs.id}/cancel`)
        .expect(401);
    });

    it('replays a key after cancellation, returning the cancelled order', async () => {
      const category = await createCategory(prisma);
      const product = await createProduct(prisma, category.id, {
        stockQuantity: 5,
      });
      await addToCart(product.id, 1);
      const order = await checkout('key-mmmmmmmm').expect(201);

      await request(app.getHttpServer())
        .post(`/api/v1/orders/${order.body.id}/cancel`)
        .set('Authorization', auth())
        .expect(200);

      const replay = await checkout('key-mmmmmmmm').expect(200);

      expect(replay.body.id).toBe(order.body.id);
      expect(replay.body.status).toBe('CANCELLED');
      expect(await prisma.order.count()).toBe(1);
    });
  });
```

- [ ] **Step 7: Run the e2e tests**

```bash
npm run test:e2e -- checkout
```

Expected: PASS.

- [ ] **Step 8: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 9: Commit**

```bash
git add src/modules/orders test/checkout.e2e-spec.ts
git commit -m "$(cat <<'EOF'
feat: add idempotent order cancellation with exactly-once stock restore

The cancel path claims the order with a PENDING predicate in the WHERE
clause, so concurrent cancels both succeed while stock returns only once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 7: Concurrency suite and negative controls

**Files:**
- Create: `test/helpers/assert-stock-conserved.ts`, `test/checkout-concurrency.e2e-spec.ts`
- Modify: `docs/superpowers/specs/2026-09-16-phase-3-cart-orders-design.md` (§11 Evidence only)

**Interfaces:**
- Consumes: everything from tasks 2–6.
- Produces: `assertStockConserved(prisma, productId, initialStock, deltas?): Promise<void>`.

**This task's deliverable is evidence, not code.** A green suite that has never
been seen red proves nothing. Steps 5–11 are the point of the task.

- [ ] **Step 1: Write the conservation helper**

Create `test/helpers/assert-stock-conserved.ts`:

```ts
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * The Phase 3 invariant (spec §5.1):
 *
 *   initialStock + sum(admin deltas)
 *     === currentStock + sum(quantity across PENDING orders)
 *
 * Stated as conservation rather than "stock >= 0" because the interesting
 * bugs — lost updates, double restoration, duplicated orders — all preserve
 * non-negativity while breaking conservation. Cancelled orders drop out of
 * the sum because their stock went back to the product.
 */
export async function assertStockConserved(
  prisma: PrismaService,
  productId: string,
  initialStock: number,
  adminDeltas = 0,
): Promise<void> {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { stockQuantity: true },
  });

  const reserved = await prisma.orderItem.aggregate({
    where: { productId, order: { status: OrderStatus.PENDING } },
    _sum: { quantity: true },
  });

  const held = reserved._sum.quantity ?? 0;

  expect(product.stockQuantity + held).toBe(initialStock + adminDeltas);
  expect(product.stockQuantity).toBeGreaterThanOrEqual(0);
}
```

- [ ] **Step 2: Write the concurrency suite skeleton and C1**

Create `test/checkout-concurrency.e2e-spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/modules/auth/token.service';
import { createTestApp } from './helpers/create-test-app';
import { truncateAll } from './helpers/truncate';
import { assertStockConserved } from './helpers/assert-stock-conserved';
import { createUser } from './factories/user.factory';
import { createCategory } from './factories/category.factory';
import { createProduct } from './factories/product.factory';

interface Shopper {
  id: string;
  token: string;
}

describe('Checkout concurrency (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let tokens: TokenService;

  beforeAll(async () => {
    // throttleLimit bypasses the guard entirely: this suite fires far more
    // than 100 requests per handler and is not testing rate limiting.
    app = await createTestApp([], { throttleLimit: 0 });
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);

    // Required. Handing supertest an unlistened server makes it call
    // listen(0) per request, which breaks under Promise.all with
    // ERR_SERVER_ALREADY_LISTEN. Proven in test/cart.e2e-spec.ts.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await truncateAll(prisma);
  });

  /** Users come from the factory with tokens minted directly, so the
   *  5/min throttle on /auth/login never applies. */
  const makeShoppers = async (count: number): Promise<Shopper[]> => {
    const shoppers: Shopper[] = [];

    for (let index = 0; index < count; index += 1) {
      const user = await createUser(prisma);
      shoppers.push({ id: user.id, token: await tokens.signAccessToken(user) });
    }

    return shoppers;
  };

  const fillCart = async (
    shopper: Shopper,
    productId: string,
    quantity: number,
  ): Promise<void> => {
    await request(app.getHttpServer())
      .put(`/api/v1/cart/items/${productId}`)
      .set('Authorization', `Bearer ${shopper.token}`)
      .send({ quantity })
      .expect(200);
  };

  const checkoutAs = (shopper: Shopper, key: string) =>
    request(app.getHttpServer())
      .post('/api/v1/orders')
      .set('Authorization', `Bearer ${shopper.token}`)
      .set('Idempotency-Key', key);

  const countStatuses = (statuses: number[]): Record<number, number> =>
    statuses.reduce<Record<number, number>>((counts, status) => {
      counts[status] = (counts[status] ?? 0) + 1;
      return counts;
    }, {});

  /** A 500 anywhere would masquerade as a correct rejection. */
  const expectNoServerErrors = (statuses: number[]): void => {
    expect(statuses.filter((status) => status >= 500)).toEqual([]);
  };

  it('C1: 25 simultaneous checkouts sell exactly the 5 units in stock', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    const shoppers = await makeShoppers(25);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 1);
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c1-key-${index.toString().padStart(4, '0')}`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 5, 409: 20 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(0);
    expect(await prisma.order.count()).toBe(5);

    // The 20 losers rolled back completely: their carts are untouched.
    expect(await prisma.cartItem.count()).toBe(20);

    await assertStockConserved(prisma, product.id, 5);
  });
});
```

- [ ] **Step 3: Run C1 and watch it pass**

```bash
npm run test:e2e -- checkout-concurrency
```

Expected: PASS with `{ 201: 5, 409: 20 }`.

- [ ] **Step 4: Add C2 through C8**

Append to the same `describe`:

```ts
  it('C2: multi-unit lines cannot oversell either', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const shoppers = await makeShoppers(10);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 3);
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) => checkoutAs(shopper, `c2-key-${index}0000`)),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 3, 409: 7 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(1);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C3: opposing multi-product carts do not deadlock', async () => {
    const category = await createCategory(prisma);
    const productA = await createProduct(prisma, category.id, {
      stockQuantity: 50,
    });
    const productB = await createProduct(prisma, category.id, {
      stockQuantity: 50,
    });
    const shoppers = await makeShoppers(20);

    for (const [index, shopper] of shoppers.entries()) {
      // Half add A then B, half add B then A. The service sorts by
      // productId, so both halves must take row locks in the same order.
      const order =
        index % 2 === 0
          ? [productA.id, productB.id]
          : [productB.id, productA.id];

      for (const productId of order) {
        await fillCart(shopper, productId, 1);
      }
    }

    const responses = await Promise.all(
      shoppers.map((shopper, index) => checkoutAs(shopper, `c3-key-${index}0000`)),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 20 });

    for (const product of [productA, productB]) {
      const after = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(after.stockQuantity).toBe(30);
      await assertStockConserved(prisma, product.id, 50);
    }
  });

  it('C4: the same idempotency key sent 10 times produces one order', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 2);

    const responses = await Promise.all(
      Array.from({ length: 10 }, () => checkoutAs(shopper, 'c4-shared-key')),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 1, 200: 9 });

    const ids = new Set(
      responses.map((response) => (response.body as { id: string }).id),
    );
    expect(ids.size).toBe(1);
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(8);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C5: one cart cannot become two orders under different keys', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 1);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (unused, index) =>
        checkoutAs(shopper, `c5-key-${index}0000`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 201: 1, 409: 9 });
    expect(await prisma.order.count()).toBe(1);

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(9);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C6: concurrent cancels restore stock exactly once', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 10,
    });
    const [shopper] = await makeShoppers(1);
    await fillCart(shopper, product.id, 4);
    const order = await checkoutAs(shopper, 'c6-checkout-key').expect(201);
    const orderId = (order.body as { id: string }).id;

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/cancel`)
          .set('Authorization', `Bearer ${shopper.token}`),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 200: 10 });

    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(after.stockQuantity).toBe(10);
    await assertStockConserved(prisma, product.id, 10);
  });

  it('C7: a restock during a checkout storm is never lost', async () => {
    const category = await createCategory(prisma);
    const product = await createProduct(prisma, category.id, {
      stockQuantity: 5,
    });
    const shoppers = await makeShoppers(10);
    const admin = await createUser(prisma, { role: Role.ADMIN });
    const adminToken = await tokens.signAccessToken(admin);

    for (const shopper of shoppers) {
      await fillCart(shopper, product.id, 1);
    }

    const responses = await Promise.all([
      ...shoppers.map((shopper, index) =>
        checkoutAs(shopper, `c7-key-${index}0000`),
      ),
      request(app.getHttpServer())
        .post(`/api/v1/admin/products/${product.id}/stock-adjustments`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ delta: 5 }),
    ]);
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);

    const successes = statuses.filter((status) => status === 201).length;
    const after = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });

    expect(after.stockQuantity).toBe(10 - successes);
    await assertStockConserved(prisma, product.id, 5, 5);
  });

  it('C8: parallel first writes create exactly one cart', async () => {
    const category = await createCategory(prisma);
    const products = [];

    for (let index = 0; index < 10; index += 1) {
      products.push(await createProduct(prisma, category.id));
    }

    const [shopper] = await makeShoppers(1);

    const responses = await Promise.all(
      products.map((product) =>
        request(app.getHttpServer())
          .put(`/api/v1/cart/items/${product.id}`)
          .set('Authorization', `Bearer ${shopper.token}`)
          .send({ quantity: 1 }),
      ),
    );
    const statuses = responses.map((response) => response.status);

    expectNoServerErrors(statuses);
    expect(countStatuses(statuses)).toEqual({ 200: 10 });
    expect(await prisma.cart.count()).toBe(1);
    expect(await prisma.cartItem.count()).toBe(10);
  });
```

`createUser(prisma, { role: Role.ADMIN })` already works — the factory spreads
`Partial<Prisma.UserCreateInput>` over its defaults. Import `Role` from
`@prisma/client` in the suite; do not create the admin by any other means.

- [ ] **Step 5: Run the whole suite**

```bash
npm run test:e2e -- checkout-concurrency
```

Expected: all eight PASS. If any test is flaky across three consecutive runs, stop and report rather than loosening an assertion.

- [ ] **Step 6: Negative control for C1 — the oversell proof**

Temporarily replace the body of `ProductsService.decrementStock` with the naive version:

```ts
    // NEGATIVE CONTROL — NEVER COMMIT THIS
    const product = await tx.product.findUnique({
      where: { id: productId },
      select: { isActive: true, stockQuantity: true },
    });

    if (!product?.isActive || product.stockQuantity < quantity) {
      return 0;
    }

    await tx.product.update({
      where: { id: productId },
      data: { stockQuantity: product.stockQuantity - quantity },
    });

    return 1;
```

Run `npm run test:e2e -- checkout-concurrency -t C1` and **record the exact numbers** (the observed status counts, the final stock, and the conservation failure). Then `git checkout -- src/modules/products/products.service.ts` and re-run to confirm green.

**If the naive version passes, the test is not racing hard enough.** Raise the shopper count until it fails, keep that number, and note it. Do not proceed with a green-only result.

- [ ] **Step 7: Negative control for C4**

Move the idempotency lookup **before** `lockForUpdate` in `CheckoutService.checkout`. Run `-t C4`, record the failure (expect replays to return 409 "Cart is empty" instead of 200), revert, re-run green.

- [ ] **Step 8: Negative control for C5**

Remove the `lockForUpdate` call from `CheckoutService.checkout` (read the cart with `listItemsForCheckout` using a cart looked up by `userId`). Run `-t C5`, record the failure (expect more than one order), revert, re-run green.

- [ ] **Step 9: Negative control for C6**

Drop `status: OrderStatus.PENDING` from the `updateMany` predicate in `OrdersService.cancel`. Run `-t C6`, record the failure (expect stock above 10 and a conservation error), revert, re-run green.

- [ ] **Step 10: Negative control for C7**

Replace `adjustStock`'s `{ increment: delta }` with an absolute set built from a prior read. Run `-t C7`, record the failure, revert, re-run green.

- [ ] **Step 11: Negative control for C8**

Replace `lockForUpdate`'s upsert with `findFirst` then `create`. Run `-t C8`, record the failure (expect P2002 → 409), revert, re-run green.

- [ ] **Step 12: Negative control for C3 (attempt, record either way)**

Remove the `orderBy: { productId: 'asc' }` from `CartService.listItemsForCheckout`, run `-t C3` up to three times, and record whether a deadlock (a 500) reproduced. Deadlocks are timing-dependent, so **this one is not a gate**: record "not reproduced in 3 runs" if that is what happened. Revert regardless.

- [ ] **Step 13: Fill in the spec's §11 Evidence table**

Replace every `*(to be recorded)*` cell in
`docs/superpowers/specs/2026-09-16-phase-3-cart-orders-design.md` §11 with the
numbers observed in Steps 6–12. Example row shape:

```
| C1 | read → check → absolute write | 11 × 201, 14 × 409, stock 0, conservation off by 6 | 5 × 201, 20 × 409, stock 0, conserved |
```

Change nothing else in the spec.

- [ ] **Step 14: Confirm the working tree is clean of every negative control**

```bash
git diff --stat
```

Expected: only `test/` additions and the spec's §11 table. **`src/` must show no changes at all** in this task. If it does, a negative control was left in — revert it before committing.

- [ ] **Step 15: Full gate, run twice**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
npm run test:e2e
```

Expected: green both times. The second run catches order-dependence and flakiness.

- [ ] **Step 16: Commit**

```bash
git add test/helpers/assert-stock-conserved.ts test/checkout-concurrency.e2e-spec.ts docs/superpowers/specs/2026-09-16-phase-3-cart-orders-design.md
git commit -m "$(cat <<'EOF'
test: prove checkout cannot oversell under concurrency

Adds C1-C8 against real Postgres, each asserting stock conservation and the
absence of 500s. Every claim was verified by first failing a naive
implementation; the observed numbers are recorded in the design spec's
evidence table.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Task 8: Documentation

**Files:**
- Modify: `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md`

- [ ] **Step 1: Add the Phase 3 section to `CLAUDE.md`**

After the Phase 2 section, add a `### Cart, orders, and checkout (Phase 3 — implemented)` block covering, in the voice of the existing entries (each point stating what breaks if it is changed):

- Stock decrement is a conditional `updateMany` whose predicate travels with the write; never a read, a check, then an update. Same idiom as `RefreshTokenService.rotate()`.
- Product row locks are taken in ascending `productId` order in checkout and cancel; unsorted locks are the classic deadlock shape on opposing carts, and sorted acquisition rules out hold-and-wait structurally. State it as required discipline, not as a proven-by-test mechanism — Step 12's control never reproduced a deadlock (spec §11).
- Prices are snapshotted **after** the locks are held, never before.
- The `Cart` row exists to be locked: every cart mutation and every checkout takes it. Deleting the model to "simplify" reopens one-cart-two-orders.
- The idempotency lookup lives **inside** the transaction, after the lock; moving it earlier makes a concurrent replay return a spurious 409.
- Cancellation claims the order with a `PENDING` predicate so restoration is exactly-once.
- Restocking is relative; `UpdateProductDto` must never gain `stockQuantity`.
- Cart quantities are **set, never accumulated** (D11); no incrementing add-to-cart route.
- `stockQuantity` is public by decision (D10); removing it is a product decision, not a cleanup.
- `describeRefusal()` explains a refusal, never authorises a sale, stays in `ProductsService`, never throws, and is not replaceable by `findOne(id, 'all')`.
- No external I/O inside the checkout transaction, ever — Phase 4's payment call goes after commit.
- `P2028`, `P2034`, and CHECK violations are deliberately unmapped 500s.
- Concurrency tests ship with recorded negative controls; a green run alone is not evidence.
- Concurrency e2e suites must `await app.listen(0)`; `maxWorkers: 1` stays.

- [ ] **Step 2: Update `README.md`**

- Add the new routes to the existing route table: `GET/PUT/DELETE /api/v1/cart…`, `POST /api/v1/orders`, `GET /api/v1/orders`, `GET /api/v1/orders/:id`, `POST /api/v1/orders/:id/cancel`, `POST /api/v1/admin/products/:id/stock-adjustments`.
- Change `- ⬜ Orders` to `- ✅ Cart & orders: transactional checkout, atomic stock decrement, idempotent order creation, cancellation with exactly-once stock restore`.
- Change the current-phase line to **payments (Phase 4)**.
- Document the `Idempotency-Key` header on checkout.

- [ ] **Step 3: Add the one new deferred-limitations entry**

Under `## Operations` in `docs/deferred-limitations.md`, add:

```markdown
### PENDING orders hold stock indefinitely

**Owner: Phase 5 (Redis + BullMQ).**

Checkout decrements stock immediately, so an order that is never paid and never
cancelled holds its units forever. There is no expiry, because expiry needs
scheduled jobs, which arrive in Phase 5.

Mitigation today: a customer can cancel their own PENDING order and the stock
returns immediately. The exposure is therefore bounded by customer behaviour,
not by an attacker — but a bot could still hold inventory by checking out and
never paying.

The fix is a periodic job that cancels PENDING orders older than a configured
age, reusing the existing cancellation path (design spec §5.6) so restoration
stays exactly-once. Do not implement a bespoke expiry that writes stock
directly.
```

**Do not edit or close any existing entry** — in particular the Phase 2 admin
category-route gap stays exactly as written.

- [ ] **Step 4: Review the Swagger output by eye**

```bash
npm run start:dev
```

Open `http://localhost:3000/api/docs` and confirm: all six new routes appear with descriptions; `Idempotency-Key` shows as a required header on `POST /orders`; `stockQuantity` appears on product responses; the cart `quantity` field documents 1–99 and says it sets rather than adds. Stop the server.

- [ ] **Step 5: Full gate**

```bash
npm run lint:ci && npm run build && npm test && npm run test:e2e
```

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md README.md docs/deferred-limitations.md
git commit -m "$(cat <<'EOF'
docs: record Phase 3 cart, order, and concurrency conventions

Documents the stock CAS, lock ordering, snapshot timing, cart-lock role, and
idempotency placement, plus the one new deferred limitation: PENDING orders
hold stock until Phase 5 can expire them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MzMkqVJ4vGz358oQdHBTxA
EOF
)"
```

---

## Phase 3 Definition of Done

Check against spec §12 before declaring the phase complete:

1. One migration adds stock, four CHECK constraints, and four models — task 1.
2. Cart, order, checkout, and cancel behave as spec §6 specifies — tasks 3–6.
3. Stock can never be oversold, proven by C1 against a recorded failing control — task 7.
4. Stock is conserved across checkout, cancellation, and admin adjustment — task 7.
5. Concurrent cancels restore stock exactly once — C6.
6. A replayed key returns the original order; concurrent replays produce one order — C4.
7. Order prices and names are immutable against later catalog edits — task 5.
8. No external I/O inside the checkout transaction.
9. `npm run lint:ci`, `npm run build`, `npm test`, `npm run test:e2e` green; CI green.
10. Spec §11 Evidence is complete; documentation updated — tasks 7–8.
11. No payment code, no Redis, no BullMQ, no background job, no admin order route, no new dependency.
