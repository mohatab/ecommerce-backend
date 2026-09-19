# Phase 3 — Cart, Orders, and Safe Checkout Design Spec

**Date:** 2026-09-16
**Status:** Draft for review — no implementation has started.
**Base:** `master` @ `7db2260` (Phase 2 merged via PR #6, CI green — unit 139/139, e2e 120/120)
**Owns:** `Cart`, `CartItem`, `Order`, `OrderItem`, `OrderStatus`, `Product.stockQuantity`, `CheckoutService`

---

## 1. Purpose and scope

Phase 3 is the project's correctness phase. Phases 1 and 2 answered *who is the
caller* and *what may they do*; Phase 3 answers *what happens when two callers
want the last unit of the same product at the same instant*.

The deliverable that matters is not the endpoint count. It is a committed,
runnable test that fails against a plausible naive implementation and passes
against the shipped one, proving stock cannot be oversold.

### In scope

1. `stockQuantity` on `Product`, with a database `CHECK` constraint and a
   relative admin stock-adjustment route.
2. `Cart` and `CartItem` models, plus authenticated cart routes.
3. `Order`, `OrderItem`, and `OrderStatus` models.
4. `CheckoutService` — one transactional checkout with atomic conditional stock
   decrement, price snapshotting, and idempotency.
5. Customer order reads and cancellation, with stock restored exactly once.
6. A concurrency e2e suite, each test paired with a recorded negative control.
7. Unit coverage of every branch in the new services.
8. Documentation updates: `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md`.

### Out of scope

Payments and any payment state (Phase 4), Redis, BullMQ and any background or
scheduled job (Phase 5), observability and deployment (Phase 6).

Permanently excluded by the foundation spec: reviews, wishlists, coupons,
shipping-provider integration, multi-vendor.

Deliberately excluded from Phase 3, additive later: shipping addresses, tax,
discounts, guest carts, admin order routes, order status history, partial
cancellation or per-line cancellation, refunds, back-orders, and multi-warehouse
inventory.

**Explicitly forbidden by the phase brief:** speculative microservices, CQRS,
event sourcing, Redis, premature abstraction. The result stays a modular
monolith.

---

## 2. Conflicts found before design

Surfaced rather than silently resolved, in the style of the Phase 2 spec.

### C1 — stock cannot be set through `PATCH /admin/products/:id`

`CLAUDE.md` freezes `UpdateProductDto` as a hand-written DTO. Adding
`stockQuantity` to it would be structurally easy and semantically wrong: an
absolute write is a lost update. An admin reads 10, a checkout commits 10 → 9,
the admin writes 15, and that sale is erased from inventory.

**Resolution:** `UpdateProductDto` is not touched. Restocking is a *relative*
adjustment on its own route (§6.3), executed as the same compare-and-swap the
checkout uses. `CreateProductDto` does accept an initial `stockQuantity`,
because creation has nothing to race with.

### C2 — the `Cart` model looks like indirection

A cart holding only `id` and `userId` is one join away from being deleted, with
`CartItem.userId` taking its place. The minimal design would drop it.

**Resolution:** `Cart` stays, for one reason that is not organisational: it is
the **per-user lock row** (§5.2). Without it, two concurrent checkouts by the
same user with different idempotency keys both read the same cart items, both
decrement stock, and produce two orders for one cart. The row earns its place by
serialising them; this spec records that so a future cleanup does not remove it
as dead weight.

### C3 — "Prisma errors are never caught in a service" vs. distinguishing failures

`CLAUDE.md` forbids catching Prisma errors in services. Checkout must
nonetheless distinguish *insufficient stock* from *product no longer available*.

**Resolution:** no conflict, because the design never relies on an exception for
control flow. `updateMany` returns `{ count }`; `count === 0` is a value, not an
error. The explanatory read that follows is an ordinary query. `P2002`, `P2003`
and `P2025` continue to be mapped only in `HttpExceptionFilter`.

Two Prisma codes are left **deliberately unmapped**:

- `P2028` (transaction timeout / pool exhaustion) — a saturation signal. A 500
  with a logged stack is the correct response; a friendly 4xx would hide load.
- `P2034` (write conflict / deadlock) — unreachable given the lock ordering in
  §5.4. If it ever appears, it is a bug in that ordering and must be loud.

A `CHECK` constraint violation is likewise a 500 by design (§4.1).

### C4 — `ProductsService` read methods require an explicit `visibility`

Phase 2 made `visibility` a required argument so no future phase could quietly
read deactivated products into an order. Phase 3 is that future phase.

**Resolution:** checkout does not read a product to decide whether it may be
sold. The `isActive` predicate travels *inside* the decrement statement
(§5.3). The only read that follows a failed decrement is diagnostic
(`describeRefusal()`, §5.3.1), and it takes **no** `ProductVisibility` at all:
its whole purpose is to tell an absent product apart from an inactive one, so it
must see the row either way. `list()` and `findOne()` keep `visibility` as a
required argument with no default, and no new default is introduced. The
invariant Phase 2 protected is preserved: what may be *sold* is decided solely by
the `isActive` predicate inside the decrement, so no code path sells an inactive
product.

### C5 — the Phase 2 deferred-limitations entry is not closed here

`docs/deferred-limitations.md` records that a fresh database has no way to create
a category through the API, so `POST /admin/products` 409s forever, and that
there is no admin product list. Phase 3 adds an admin route in the same
controller and will be tempted to fix both in passing.

**Resolution:** it does not. `CLAUDE.md` names this exact drive-by and forbids
it. Phase 3's e2e tests create categories through `test/factories`, which is
what Phase 2's tests already do. The entry stays open and unedited.

### C6 — flag only: checkout inherits the per-handler rate limit

`POST /orders` gets the default 100 req/min **per handler, per IP**. Behind a
proxy, and with `docs/deferred-limitations.md` entry 1 (no trusted-proxy
configuration, owner Phase 6) still open, that is one shared bucket for all
customers. Checkout makes this more consequential than a catalog read did.

**Phase 3 changes no throttler configuration and does not re-own that entry.**
It is recorded here; ownership stays with Phase 6.

### C7 — the e2e harness has never issued parallel requests

Existing suites pass an unlistened server to supertest, which calls `listen(0)`
itself per request. That is safe sequentially. Firing requests with
`Promise.all` against the same server is expected to throw
`ERR_SERVER_ALREADY_LISTEN`.

**Resolution:** concurrency suites call `await app.listen(0)` during setup and
`await app.close()` in teardown. The first concurrency task verifies the failure
mode before relying on the fix (§9.2, task ordering).

---

## 3. Decisions at a glance

| # | Decision | Choice |
|---|---|---|
| **D1** | When stock leaves inventory | At checkout. The order is created `PENDING` and cancellation restores stock. Overselling is impossible by construction; Phase 4 only changes status. |
| **D2** | Where stock lives | `Product.stockQuantity` plus `CHECK (stock_quantity >= 0)`. No `Inventory` table. |
| **D3** | Concurrency control | Conditional atomic decrement (`updateMany` with the predicate in the `WHERE`) under READ COMMITTED. No `SELECT … FOR UPDATE`, no SERIALIZABLE, no retry loop, no version column. |
| **D4** | Idempotency | Required `Idempotency-Key` header, stored as `@@unique([userId, idempotencyKey])` on `Order`. No separate idempotency table. |
| **D5** | Lifecycle in Phase 3 | `PENDING` and `CANCELLED` only. No admin order routes. `PAID` arrives in Phase 4 as an additive enum value. |
| **D6** | Restocking | Relative `POST /admin/products/:id/stock-adjustments { delta }`, never an absolute set. |
| **D7** | Per-user serialisation | The `Cart` row is locked by every cart mutation and every checkout. |
| **D8** | Price snapshot | `productName` and `unitPriceCents` copied onto `OrderItem` **after** the product row lock is held. |
| **D9** | Proof obligation | Every concurrency test ships with a recorded negative control that made it fail. |
| **D10** | Public stock visibility | The exact `stockQuantity` is in `ProductResponseDto` and **shown by the public catalog**. A deliberate product decision, with its cost accepted — §4.1.1. |
| **D11** | Cart quantity semantics | `PUT /cart/items/:productId` **sets** the quantity (1–99) and is idempotent. No incrementing add-to-cart route exists — §4.3, §6.2. |
| **D12** | Refusal diagnostics | `ProductsService.describeRefusal(tx, …)` returns `'missing' \| 'inactive' \| 'insufficient-stock'`, never throws, and is the only way checkout learns why a decrement was refused. `findOne(id, 'all')` is deliberately not used — §5.3.1. |

---

## 4. Data model

One migration, generated with `prisma migrate dev --create-only` and edited by
hand **before first application** to add `CHECK` constraints, which Prisma's
schema language cannot express. `CLAUDE.md` forbids editing a migration once
applied or merged; editing before either is the sanctioned path.

### 4.1 `Product.stockQuantity`

```prisma
stockQuantity Int @default(0) @map("stock_quantity")
```

```sql
ALTER TABLE "products"
  ADD CONSTRAINT "products_stock_quantity_non_negative"
  CHECK ("stock_quantity" >= 0);
```

- **Default 0.** Existing rows become unsellable rather than infinitely
  sellable. Nothing sells until stock is set deliberately.
- **The `CHECK` is a backstop, not the mechanism.** §5.3 already guarantees
  non-negativity. The constraint exists so that a future code path bypassing the
  service cannot corrupt inventory. If it ever fires, the request fails with a
  logged 500 — correct, because reaching it is a bug, not a user error.
- **Exposure — D10, a deliberate product and API decision.**
  `ProductResponseDto` gains `stockQuantity`, and **the public catalog shows the
  exact number** to unauthenticated callers on both `GET /api/v1/products` and
  `GET /api/v1/products/:id`. This is chosen, not a side effect of reusing one
  DTO, and §4.1.1 records why.
- **Indexes.** None added. No query filters or sorts on stock; the existing
  `[isActive, createdAt]` index still serves the catalog.

#### 4.1.1 D10 — public stock visibility

**Decision: the exact `stockQuantity` is public.** Considered and rejected:
an `inStock: boolean`, a coarse band ("low stock"), and admin-only exposure via
a second response DTO.

Why exact and public:

1. **It is the honest answer to a question the API already invites.** Checkout
   can fail with 409 "Insufficient stock". Without a published number, a client
   discovers its limit only by attempting to buy, which is a worse experience
   than showing "3 left" and is what storefronts publish anyway.
2. **Nothing is leaked that a determined caller cannot already measure.** Stock
   is inferable by binary-searching quantities against checkout failures.
   Publishing it removes the incentive to grind the checkout endpoint for a
   number, which is the more expensive route for the server.
3. **A boolean would be a second derived truth.** `inStock` is
   `stockQuantity > 0`, computed in the mapper, and the first time someone wants
   "only 2 left" the field has to change shape anyway.
4. **A second DTO costs more than it protects.** Phase 2 established one
   response DTO per resource with a static `from()`. An admin-only variant means
   two mappers to keep synchronised for a field with no credential value.

What this decision **does not** grant: no reserved-quantity figure, no per-order
data, and no history. Competitor sales-rate inference (watching stock fall over
time) is the known cost and is accepted — this is a portfolio catalog, not a
price-sensitive marketplace, and the roadmap has no multi-vendor phase where it
would matter.

**If it ever needs reversing**, the change is local: drop the field from
`ProductResponseDto.from()` and add it to the admin path only. No schema or
service change is involved, which is another reason not to hedge now. It is
recorded here so a reviewer sees a decision with a cost, not an oversight — and
so that a later phase does not "fix" the exposure without knowing it was
weighed.

### 4.2 `Cart`

```prisma
model Cart {
  id        String     @id @default(uuid(7))
  userId    String     @unique @map("user_id")
  user      User       @relation(fields: [userId], references: [id], onDelete: Cascade)
  items     CartItem[]
  createdAt DateTime   @default(now()) @map("created_at")
  updatedAt DateTime   @updatedAt @map("updated_at")

  @@map("carts")
}
```

`@unique` on `userId` is what makes the row a lock: one per user, addressable
without a prior read. `onDelete: Cascade` — a deleted user's cart is worthless.

### 4.3 `CartItem`

```prisma
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
  @@map("cart_items")
}
```

```sql
ALTER TABLE "cart_items"
  ADD CONSTRAINT "cart_items_quantity_positive" CHECK ("quantity" > 0);
```

- **One line per product**, enforced by the compound unique.
- **Quantity is set, never accumulated — this is the final contract.**
  `PUT /cart/items/:productId` **assigns** the quantity for that product; it does
  **not** add to whatever was there. Sending `{ quantity: 2 }` three times leaves
  the line at 2, not 6, so the operation is idempotent and involves no
  read-modify-write, and therefore no lost update between two of the user's own
  tabs. `quantity` must be an integer in **1–99** on every request; 0 is not a
  removal (`DELETE` is), and both 0 and 100 are 400s from the DTO. An earlier
  draft of this design had add-to-cart incrementing an existing line; that
  version is superseded and must not resurface in code, tests, or Swagger
  copy. §6.2 states the same contract at the route level.
- **No price is stored.** A cart is an intent, not a quote. The snapshot happens
  at checkout, under the lock.
- **No stock check on add.** Stock is only ever guaranteed at checkout; checking
  earlier is a check-then-act race wearing the costume of validation.
- `onDelete: Restrict` on the product mirrors Phase 2: products are soft-deleted,
  never removed.

### 4.4 `Order` and `OrderStatus`

```prisma
enum OrderStatus {
  PENDING
  CANCELLED
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
```

- **Idempotency lives on the order row.** The unique constraint *is* the
  idempotency record, written in the same transaction as the order, so the two
  can never disagree. A separate table would need its own consistency story.
- Keys are **scoped to the user**, so one customer cannot replay another's key or
  probe for existence.
- `onDelete: Restrict` on `userId`: orders are financial history. No route
  deletes users today; this prevents a later cascade from erasing that history.
- `totalCents` is **stored** although derivable. It is the amount Phase 4 will
  charge, fixed at checkout. It is computed in JavaScript (exact to 2^53) and
  rejected with 422 if it exceeds `INT` range (§5.5).
- `currency` is per order; a mixed-currency cart is rejected (§5.5).
- Phase 4 adds `PAID` with `ALTER TYPE … ADD VALUE`, which is additive and does
  not rewrite rows.

### 4.5 `OrderItem`

```prisma
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
  @@map("order_items")
}
```

```sql
ALTER TABLE "order_items"
  ADD CONSTRAINT "order_items_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "order_items_unit_price_non_negative" CHECK ("unit_price_cents" >= 0);
```

- `productName` and `unitPriceCents` are the **snapshot**: history must not move
  when an admin edits the catalog. `productId` is retained because Phase 2
  guaranteed product rows are never deleted.
- **Line totals are not stored.** `unitPriceCents × quantity` is computed in the
  response DTO; a stored copy is a second source of truth for one multiplication.

### 4.6 Not added

No `version` column (D3 needs no optimistic locking), no `Inventory` table, no
`OrderStatusHistory` (two states), no `Address`, no `reservedQuantity`
(reservation *is* the decrement under D1).

---

## 5. Concurrency design

### 5.1 The invariant

> For every product: `initialStock + Σ(admin deltas) = currentStock +
> Σ(quantity of that product across PENDING orders)`

Stated as conservation rather than `stock >= 0`, because the interesting bugs —
lost updates, double restoration, duplicated orders — all preserve
non-negativity while breaking conservation. §8.1 turns this into a test helper.

### 5.2 The per-user lock

Every cart mutation and every checkout begins with:

```ts
const cart = await tx.cart.upsert({
  where:  { userId },
  create: { userId },
  update: { updatedAt: new Date() },
});
```

The `update` branch takes a row lock held until commit. Three effects:

1. **Concurrent checkouts by one user serialise.** The second sees the committed
   result of the first, rather than re-reading the same cart.
2. **Cart edits cannot interleave** between reading the cart and clearing it.
3. **First-cart creation does not race.** Prisma compiles this shape to a native
   `INSERT … ON CONFLICT`, so two first-time requests do not produce `P2002`.
   This is an assumption about Prisma's query compilation, so it is **verified by
   test C8** (§8.2) rather than trusted.

### 5.3 The stock decrement — D3

```ts
const { count } = await tx.product.updateMany({
  where: { id: productId, isActive: true, stockQuantity: { gte: quantity } },
  data:  { stockQuantity: { decrement: quantity } },
});
```

Correctness argument, in full, because this is the phase's central claim:

- The check and the write are **one statement**. There is no window between
  them for another transaction to occupy.
- When two transactions target the same row, PostgreSQL blocks the second on the
  first's row lock. On release, an `UPDATE` **re-evaluates its `WHERE` against
  the newly committed row version** before writing (`EvalPlanQual`). A decrement
  that was valid against stale data therefore does not proceed: it matches zero
  rows.
- Hence READ COMMITTED is sufficient. No `SELECT … FOR UPDATE`, no
  SERIALIZABLE, no retry.
- `count === 0` means *this decrement was refused*, without saying why. Choosing
  the message is delegated to `ProductsService.describeRefusal()`, specified in
  §5.3.1.
- Throwing rolls back every decrement already applied in this transaction, so an
  order is all-or-nothing.

**Precedent in this codebase:** `RefreshTokenService.rotate()` claims a token
with `updateMany({ where: { id, revokedAt: null } })` and treats `count === 0` as
reuse, for exactly the reason above — the predicate must travel with the write.
Phase 3 applies the same idiom to stock, deliberately, so there is one
concurrency pattern in the project rather than two.

**Rejected alternatives**

| Alternative | Why not |
|---|---|
| `SELECT … FOR UPDATE`, then check in JS, then update | Correct, but needs `$queryRaw` (Prisma exposes no `FOR UPDATE`), costs an extra round trip per line while holding the lock, and moves the invariant out of the database into application code. |
| SERIALIZABLE + retry on `40001` | Correct, but a conflict aborts the whole checkout and correctness then depends on a retry loop that is easy to get subtly wrong. Throughput degrades under exactly the contention being demonstrated. |
| Optimistic `version` column | Re-implements in the application what one row predicate already expresses, and adds a retry loop for the same reason as above. |
| Application-level mutex / advisory lock | Serialises unrelated products, and an advisory lock is one more thing to leak on an error path. |

### 5.3.1 `ProductsService.describeRefusal()` — the diagnostic boundary

```ts
export type StockRefusal = 'missing' | 'inactive' | 'insufficient-stock';

describeRefusal(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<StockRefusal>;
```

**Called only after a decrement returned `count === 0`.** It explains a refusal
that already happened; it never authorises a sale and is never consulted before
a decrement.

**It lives in `ProductsService`, not `CheckoutService`.** `CheckoutService` must
not issue `tx.product.findUnique(...)` itself. The `products` table has one
owning module (`CLAUDE.md` module boundaries), and the stock predicate and its
explanation must sit next to each other — if a future change alters the
`decrement` predicate, the explanation is in the same file and moves with it.
Splitting them is how the two drift into disagreeing about the same refusal.

**The three cases and exactly what checkout does with each:**

| Return | Condition | Checkout outcome |
|---|---|---|
| `'missing'` | No row with that id | **409**, "Product is no longer available". Not 404: the resource being addressed is the order, and the caller's cart is what referenced a vanished product. Unreachable in practice — `CartItem.productId` is `onDelete: Restrict` and Phase 2 never hard-deletes products — so the service **logs a warning** when it occurs, since it means an invariant elsewhere broke. |
| `'inactive'` | Row exists, `isActive = false` | **409**, "Product is no longer available". Same public message as `'missing'`; the distinction is for logs and tests, not for the client. |
| `'insufficient-stock'` | Row exists and is active, so the stock floor is what the decrement's predicate refused on | **409**, "Insufficient stock". |

Returning distinct values while two of them share one client message is
deliberate: unit tests assert the three branches separately (§8.5), and the
client learns nothing about *which* products exist.

**It never throws**, which is precisely why `findOne(id, 'all')` is **not** used
here:

- `findOne()` throws `NotFoundException` when the product is outside the
  requested visibility, so an absent product would surface as a **404 on
  `POST /orders`** — a misleading status for a checkout, and a control-flow
  exception in the middle of a transaction that still has decrements to roll
  back.
- `findOne()` cannot see a transaction: it queries `this.prisma`, so inside
  checkout it would read *outside* the current transaction and could return a
  row version inconsistent with the locks just taken. `describeRefusal()` takes
  `tx` as a required first parameter for that reason, like every other
  transactional method in §7.
- Its three-value result maps directly to the message and the log level, with no
  second inspection of the returned entity by the caller.

**The Phase 2 visibility contract is unchanged.** `ProductVisibility` keeps its
three values, `list()` and `findOne()` keep `visibility` as a required argument
with no default, and no new default is introduced anywhere.
`describeRefusal()` does **not** take a `ProductVisibility`: it is not a catalog
read and has no visibility to choose — by construction it must see the row
regardless of `isActive`, because distinguishing inactive from absent *is* its
job. Adding a visibility parameter would let a caller ask a diagnostic question
that cannot answer itself. This is why it is a separate, narrowly typed method
rather than a widening of the existing read API — the §C4 invariant that no
code path *sells* an inactive product is untouched, since selling is decided
solely by the `isActive` predicate inside the decrement (§5.3).

### 5.4 Lock ordering — deadlock avoidance

- Checkout: **cart row**, then **product rows in ascending `productId` order**.
- Cancel: **order row**, then **product rows in ascending `productId` order**.
- Admin adjustment: a single product row.

All paths take product locks in the same order, so no cycle exists. Checkout
never locks an existing order row (it inserts one), so checkout and cancel cannot
form a cycle either. The sort is not cosmetic: without it, carts `[A, B]` and
`[B, A]` deadlock, and PostgreSQL resolves that by aborting one transaction with
a 500. Test C3 covers it.

### 5.5 Checkout algorithm

`POST /api/v1/orders`, header `Idempotency-Key` matching
`^[A-Za-z0-9_-]{8,128}$` (400 otherwise). No request body: checkout consumes the
caller's cart.

```
$transaction(isolationLevel: ReadCommitted, maxWait: 5s, timeout: 10s):

  1. cart     = CartService.lockForUpdate(tx, userId)          // §5.2
  2. existing = tx.order.findUnique({ userId_idempotencyKey })
       found → return { order: existing, replayed: true }      // → 200
  3. items    = tx.cartItem.findMany({ cartId }) sorted by productId
       empty → 409 "Cart is empty"
       more than 50 lines is impossible (§6.2 caps it at write time)
  4. for each item, in productId order:
       count = ProductsService.decrementStock(tx, productId, quantity)
       count === 0 → ProductsService.describeRefusal(tx, …)  // §5.3.1
                     → 409 (unavailable | insufficient stock)
  5. products = tx.product.findMany({ id: { in: ids } })       // AFTER the locks
  6. distinct currencies > 1            → 422
     total = Σ unitPriceCents × qty
     total > 2_147_483_647              → 422
  7. tx.order.create({ userId, idempotencyKey, totalCents, currency,
                       items: { create: snapshots } })
  8. CartService.clear(tx, cartId)
  → return { order, replayed: false }                          // → 201
```

**Why the idempotency lookup is step 2 and not a pre-transaction fast path.**
Two requests carrying the same key arrive together. The second blocks on the
cart lock at step 1. When it proceeds, the first has committed, and under READ
COMMITTED each statement sees the latest committed snapshot — so step 2 finds
that order and replays it. A lookup *before* the lock would miss the in-flight
order and the second request would reach an empty cart and wrongly return 409.
One check in the correct position also makes the `P2002` path on
`(userId, idempotencyKey)` unreachable in practice; if it ever fires,
`HttpExceptionFilter` already maps it to 409 and nothing is caught locally.

**Why prices are read at step 5, after the decrements.** By then the transaction
holds a row lock on every product in the order, so no admin price update can
commit between the price read and the order insert. The snapshot is guaranteed
to describe the same row version that supplied the stock. Reading prices first
would be cheaper and wrong.

**Rules for the transaction body**

- **No external I/O.** No HTTP calls, no token signing, no `argon2`. Phase 4's
  payment call happens after commit. This is the Phase 1 rule about never
  holding a lock across JWT signing, restated for the money path.
- **Explicit `maxWait` and `timeout`,** as named constants with a comment.
  Prisma's defaults (2 s / 5 s) are tight for a body that waits on row locks
  while holding a pooled connection.
- **Known ceiling:** checkouts of the *same* product serialise on its row lock,
  so single-SKU throughput is bounded by lock hold time (~10–20 ms). This is
  correct behaviour, carries a `ponytail:` comment naming a reservation queue as
  the upgrade path, and is **not** a deferred-limitations entry, because nothing
  is broken.

### 5.6 Cancellation

`POST /api/v1/orders/:id/cancel`

```
$transaction:
  1. count = tx.order.updateMany({
       where: { id, userId, status: PENDING },
       data:  { status: CANCELLED, cancelledAt: new Date() },
     })
  2. count === 0 → tx.order.findFirst({ id, userId })
       none              → 404   (another user's order is also 404: no existence leak)
       already CANCELLED → 200 with the order, stock untouched (idempotent)
  3. for each item, in productId order:
       ProductsService.incrementStock(tx, productId, quantity)
       // no isActive predicate: stock returns even to a deactivated product
```

The step-1 compare-and-swap is what makes restoration **exactly once**: racing
cancels both return 200, and only the one whose `updateMany` matched increments
stock. Idempotent repetition matches Phase 2's `DELETE`, which returns 204 on an
already-deactivated product.

---

## 6. API surface

All new routes are authenticated; none is `@Public()`. Every route is documented
with `@ApiTags`, `@ApiOperation` and `@ApiResponse`, per `CLAUDE.md`.

### 6.1 Orders

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/orders` | Checkout. Requires `Idempotency-Key`. 201 new, 200 replayed. |
| `GET` | `/api/v1/orders` | The caller's orders only. `PaginationQueryDto`, newest first, `PaginatedDto` + `@ApiPaginatedResponse(OrderResponseDto)`. |
| `GET` | `/api/v1/orders/:id` | The caller's order. Another user's → 404. |
| `POST` | `/api/v1/orders/:id/cancel` | Idempotent. |

The status code varies (201 vs 200), so the controller sets it via
`@Res({ passthrough: true })` on the checkout handler only; the service returns
`{ order, replayed }` and never touches the response object.

### 6.2 Cart

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/v1/cart` | Items with live product name, price, currency, stock, `isActive`. Does **not** create a `carts` row; an absent cart reads as empty. |
| `PUT` | `/api/v1/cart/items/:productId` | `{ quantity }`, integer **1–99**. **Assigns** the quantity; never adds to the existing line. Idempotent: repeating the same request leaves the same state. 200. |
| `DELETE` | `/api/v1/cart/items/:productId` | 204, idempotent. |

**The quantity contract, stated once and identically in §4.3:** `PUT` sets,
repeated `PUT`s are idempotent, and `quantity` stays within 1–99. There is no
add-to-cart route that increments a line, and none is to be added; a client that
wants "one more" sends the new absolute quantity. 0 and 100 are DTO validation
failures (400), and removal is `DELETE`, not `{ quantity: 0 }`.

`PUT` takes the cart lock, validates the product through
`ProductsService.findOne(productId, 'active-only')` (404 for unknown or
inactive), enforces the **50-line cap** (422), then upserts the item. The active
check runs without a lock and is a user-experience nicety; §5.5 step 4 is the
authority, so a product deactivated in between is still caught at checkout.

No `DELETE /cart` (clear-all). Nothing needs it; removing lines works.

### 6.3 Admin stock

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/v1/admin/products/:id/stock-adjustments` | `{ delta }`, non-zero integer in `[-1_000_000, 1_000_000]`. |

Lives on `AdminProductsController`, inheriting its class-level
`@Roles(Role.ADMIN)`. Implemented as
`updateMany({ where: { id, stockQuantity: { gte: -delta } }, data: { stockQuantity: { increment: delta } } })`
— the same CAS, so a reduction below zero returns 409 rather than reaching the
`CHECK`. No `isActive` predicate: an inactive product may be restocked. `count === 0`
→ unknown id 404, otherwise 409.

Returns the updated product as `ProductResponseDto`. Reason: the caller needs
the resulting stock level, and a relative operation makes that unguessable.

### 6.4 Response DTOs

`OrderResponseDto`, `OrderItemResponseDto`, `CartResponseDto`,
`CartItemResponseDto` — each with a static `from()` mapper, per `CLAUDE.md`.
No Prisma model is returned directly. `OrderItemResponseDto` exposes
`lineTotalCents`, computed in the mapper.

### 6.5 Status codes

| Case | Status |
|---|---|
| Missing or malformed `Idempotency-Key`; invalid quantity or delta | 400 |
| Unauthenticated | 401 |
| Non-admin on the stock route | 403 |
| Unknown order, another user's order, unknown/inactive product on `PUT` | 404 |
| Empty cart, insufficient stock, unavailable product, adjustment below zero | 409 |
| Mixed currency, total overflow, 51st cart line | 422 |
| New order | 201 |
| Replayed key, already-cancelled order, cart writes | 200 |

409 means *the state of the world refuses this*; 422 means *this request is
coherent but unprocessable*. The split is stated here because reviewers ask.

---

## 7. Module and service layout

```
src/modules/cart/
  cart.controller.ts  cart.module.ts  cart.service.ts  dto/
src/modules/orders/
  orders.controller.ts  orders.module.ts
  orders.service.ts        # reads + cancel
  checkout.service.ts      # the transaction
  dto/
src/modules/products/      # extended
  products.service.ts      # + decrementStock / incrementStock / adjustStock
                           #   + describeRefusal (diagnostic read, §5.3.1)
  admin-products.controller.ts  # + stock-adjustments route
  dto/adjust-stock.dto.ts
```

| Module | Imports |
|---|---|
| `CartModule` | `ProductsModule` |
| `OrdersModule` | `ProductsModule`, `CartModule` |

Both are registered in `AppModule` after `ProductsModule`. Guard registration
order is untouched.

**Transactional methods take `tx: Prisma.TransactionClient` as a required first
parameter, with no default.** This is the same technique as Phase 2's required
`visibility`: running the stock CAS outside checkout's transaction must fail to
compile, not merely be discouraged. `CartService.lockForUpdate(tx, userId)` and
`CartService.clear(tx, cartId)` follow the same rule.

Each table stays inside its owning module: `CheckoutService` never reads or
writes `products` or `cart_items` directly — it goes through `ProductsService`
and `CartService`, passing `tx`. It owns `orders` and `order_items` only. This satisfies the `CLAUDE.md` module
boundary rule while keeping the foundation spec's "split by use case, not by
layer" (`CheckoutService` beside `OrdersService`, no repository).

---

## 8. Test strategy

### 8.1 The conservation helper

`test/helpers/assert-stock-conserved.ts` asserts §5.1 for a product, summing
`OrderItem.quantity` across that product's `PENDING` orders. Cancelled orders
drop out, because their stock went back. **Every concurrency test ends with it.**

### 8.2 Concurrency suite — `test/checkout-concurrency.e2e-spec.ts`

Harness: real HTTP against the dockerized Postgres on 5433; requests fired with
`Promise.all`; users from `createUser`; access tokens minted directly via
`app.get(TokenService).signAccessToken(user)` so the 5/min auth throttle is never
touched; `createTestApp([], { throttleLimit: 0 })`; `await app.listen(0)` in
setup (§C7).

**Every test additionally asserts that no response is 500** — a hidden `P2028`
or `P2034` would otherwise masquerade as a correct rejection and the suite would
pass for the wrong reason.

| # | Scenario | Assertions | Negative control it must catch |
|---|---|---|---|
| C1 | Stock 5; 25 users each with quantity 1 check out simultaneously | exactly 5 × 201, 20 × 409; stock 0; 5 orders; the 20 losers' carts intact; conservation | read → check in JS → absolute `update`. Yields **more than 5 × 201** with stock ≥ 0, so the `CHECK` cannot mask it. |
| C2 | Stock 10; 10 users with quantity 3 | exactly 3 × 201; stock 1; conservation | same |
| C3 | A and B at stock 50; 20 users, half `[A,B]`, half `[B,A]` | 20 × 201; zero 500s; A = B = 30 | remove the `productId` sort → deadlock. Timing-dependent, so **attempted and recorded**, not a pass/fail gate. |
| C4 | One user, **same key**, 10 parallel checkouts | 1 × 201, 9 × 200, all the same `order.id`; one order row; stock decremented once | idempotency lookup moved before the lock → losers get 409 "Cart is empty" |
| C5 | One user, **different keys**, 10 parallel checkouts | 1 × 201, 9 × 409 "Cart is empty"; exactly one order | remove the cart lock → multiple orders from one cart |
| C6 | 10 parallel cancels of one order | 10 × 200; stock restored **exactly once**; conservation | cancel without the `status: PENDING` predicate |
| C7 | Stock 5; 10 checkouts and a `+5` adjustment simultaneously | conservation; stock = 10 − successes; no 500 | adjustment as an absolute set → lost update |
| C8 | A new user sends 10 parallel `PUT /cart/items/:id` for 10 products | 10 × 200; exactly **one** `carts` row; 10 items | `findFirst` then `create` → `P2002` → 409. Also validates the §5.2 native-upsert assumption. |

### 8.3 Negative controls — D9

Naive code is **never committed**, and no test-only switch is added to `src/`.
For C1, C4, C5, C6, C7 and C8, the plan task that introduces the test includes:

1. substitute the naive implementation named above;
2. run the test and capture the failing output;
3. revert;
4. re-run and confirm green.

The captured numbers go into §11 (Evidence). **If a naive version does not fail,
the test is not racing hard enough**: the task is blocked until load is raised,
and is never marked done on the strength of a green run alone. This mirrors
Phase 1's recorded evidence that the pre-CAS rotation consumed one token twice.

### 8.4 Deterministic e2e

- **Checkout:** partial-failure rollback (A stock 10, B stock 0 → 409, A still
  10, no order, cart unchanged); mixed currency → 422; overflow total → 422;
  product deactivated while in cart → 409; empty cart → 409.
- **Idempotency:** missing/malformed header → 400; key replayed after cancel →
  200 with the cancelled order; user B reusing user A's key gets their own new
  order.
- **Price snapshot:** check out, then admin renames the product and changes its
  price; `GET /orders/:id` still shows the old name, price and line total.
- **Cart (D11):** `PUT {quantity: 2}` three times leaves the line at **2, not
  6**; quantity 0 or 100 → 400; unknown or inactive product → 404; 51st line →
  422; `DELETE` twice → 204 twice; `GET /cart` creates no row.
- **Public stock exposure (D10):** an unauthenticated `GET /api/v1/products` and
  `GET /api/v1/products/:id` both include `stockQuantity`, and the value tracks
  checkout and admin adjustments. Asserted so the decision cannot be silently
  reversed.
- **Orders:** list paginated, newest first, caller-scoped; another user's order
  → 404 on both `GET` and cancel.
- **Authorization matrix:** every new route without a token → 401;
  `stock-adjustments` as CUSTOMER → 403; below-zero delta → 409; unknown id →
  404.

### 8.5 Unit tests

Unit tests cover **branches**, not races — stated explicitly so a green unit
suite is never mistaken for a concurrency proof.

- `CheckoutService`: decrements run in sorted order regardless of cart order;
  each `describeRefusal()` value maps to its 409 message (`'missing'` and
  `'inactive'` share one client message; `'missing'` additionally logs a
  warning); the replay path returns before any decrement; currency and overflow
  422s; the snapshot uses the post-lock read.
- `OrdersService.cancel`: all three `count === 0` branches; increments sorted.
- `ProductsService`: `adjustStock` 404 vs 409; the exact predicates of
  `decrementStock` / `incrementStock`; `describeRefusal()` returns each of its
  three values for the matching row state, **never throws**, and queries through
  the `tx` it is given rather than `this.prisma`.
- `CartService`: the 50-line cap; the lock is taken before the upsert; `PUT`
  writes an absolute quantity (the upsert's `update` branch assigns, and never
  uses `{ increment }`).

### 8.6 Harness rules

- **`maxWorkers: 1` stays.** Concurrency here is *within* a single test in a
  single process against a single database, so the `truncateAll` race between
  workers is untouched. Nobody may raise it to speed these tests up.
- `truncateAll()` picks up the new tables automatically; it reads `pg_tables`.
- New factories `createCart` and `createOrder` insert through the Prisma client
  only, never `$executeRaw` (ids are client-side `uuid(7)`). `createProduct`
  gains a `stockQuantity` default.
- Prisma's connection pool is left at its default, so tests run under the same
  pool as production; the no-500 assertion is what makes saturation visible.

### 8.7 Gate

`npm run lint`, `npm run build`, `npm test`, and — because everything here is
DB-dependent — `npm run test:e2e`, all green before any task is done.

---

## 9. Task order

| # | Task | Depends on | Done when |
|---|---|---|---|
| 1 | Schema + hand-edited migration (stock, `CHECK`s, `Cart`, `CartItem`, `Order`, `OrderItem`, `OrderStatus`); factories updated | — | `migrate dev` applies cleanly; `createProduct`/`createCart`/`createOrder` insert rows; existing suites still green |
| 2 | `ProductsService` stock methods + `adjust-stock` DTO + admin route + unit tests | 1 | Unit green; e2e for 404/409/403 green |
| 3 | `CartModule`: service, lock, DTOs, routes, unit + e2e | 1 | Cart e2e green; C8 harness (`app.listen(0)`) proven, including the `ERR_SERVER_ALREADY_LISTEN` failure it fixes |
| 4 | `OrdersModule` skeleton: reads (`GET /orders`, `GET /orders/:id`), response DTOs | 1 | Caller-scoping e2e green (another user's order → 404) |
| 5 | `CheckoutService` + `POST /orders` + idempotency + unit tests | 2, 3, 4 | Deterministic checkout e2e green (§8.4) |
| 6 | Cancellation + unit tests | 5 | Idempotent-cancel e2e green |
| 7 | **Concurrency suite C1–C8 with recorded negative controls** | 5, 6 | Every test green *and* every negative control recorded as having failed first; §11 filled in |
| 8 | Documentation: `CLAUDE.md`, `README.md`, `docs/deferred-limitations.md`, Swagger review | 7 | §10 satisfied |

Hard orderings, restated because they break silently:

- **Task 1's migration is hand-edited before it is ever applied.** Once applied
  or merged it is frozen; a forgotten `CHECK` then needs a second migration.
- **Task 7 cannot start before 5 and 6**, because a negative control needs the
  real implementation to revert to.
- **Task 3 must prove the parallel-request harness before task 7 depends on it.**

---

## 10. Documentation expectations

**`CLAUDE.md`** gains a Phase 3 section stating, in the voice of the existing
entries:

- stock decrement is a conditional `updateMany` and the predicate must travel
  with the write — never a read, a check, then an update;
- product locks are always taken in ascending `productId` order;
- prices are snapshotted *after* the locks are held, never before;
- the `Cart` row exists to be locked, and every cart mutation and checkout takes
  that lock;
- the idempotency lookup lives **inside** the transaction, after the lock;
- restocking is relative; `UpdateProductDto` must never gain `stockQuantity`;
- cart quantities are **set, never accumulated** (D11), and no incrementing
  add-to-cart route is to be introduced;
- the exact `stockQuantity` is **public by decision** (D10, §4.1.1) — removing it
  from the public catalog is a product decision, not a cleanup;
- `describeRefusal()` explains a refusal and never authorises a sale; it stays in
  `ProductsService`, never throws, and `findOne(id, 'all')` must not replace it
  (§5.3.1);
- no external I/O inside the checkout transaction, ever;
- `P2028`, `P2034` and `CHECK` violations are deliberately unmapped 500s;
- concurrency tests ship with recorded negative controls;
- `ProductVisibility`'s required argument survives Phase 3 (§C4).

**`README.md`:** the new routes in the existing table; Project Status moves
Orders to ✅ and the current phase to Payments (Phase 4).

**`docs/deferred-limitations.md`** gains exactly one new entry:

> **PENDING orders hold stock indefinitely — owner: Phase 5 (Redis + BullMQ).**
> Checkout decrements stock immediately, so an order that is never paid and
> never cancelled holds its units forever. There is no expiry, because expiry
> needs scheduled jobs, which arrive in Phase 5. Mitigation today: a customer
> can cancel and get the stock back. The fix is a periodic job cancelling
> `PENDING` orders older than a configured age, using exactly the cancellation
> path in §5.6 so restoration stays exactly-once.

The Phase 2 entries are **not** edited, and the category-route gap is not closed
in passing (§C5). The per-SKU lock ceiling (§5.5) is a `ponytail:` comment in the
code, not an entry, because nothing about it is broken.

---

## 11. Evidence

Filled in by task 7, before Phase 3 can be called done. Each row records the
naive implementation, the observed failure, and the observed pass.

| Test | Naive implementation | Failing result | Passing result |
|---|---|---|---|
| C1 | read → check → absolute write | 25 × 201, 0 × 409, stock 4 (lost updates, not 0), 25 orders, 0 cart items remaining; conservation: stock 4 + held 25 = 29 ≠ initial 5, off by 24 | 5 × 201, 20 × 409, stock 0, 5 orders, 20 losers' carts intact, conserved |
| C3 | **Control A (the brief's prescribed control):** unsorted product locks — remove `orderBy: { productId: 'asc' }` from `CartService.listItemsForCheckout` only.<br><br>**Control B (the honest, harder control, added on review):** the same removal, **plus** removing `CheckoutService.checkout`'s defensive `sortedItems` re-sort, so cart items reach the decrement loop in whatever order the query returns them, with no lock-ordering guarantee left anywhere on the path. | **Control A:** attempted 3 consecutive runs; no deadlock reproduced in any run — all 3 passed `{ 201: 20 }`, A = B = 30, conserved. This control could never fire: `CheckoutService.checkout` independently re-sorts `sortedItems` by `productId` before decrementing (its own defensive re-sort, documented in `checkout.service.ts`), so removing only `CartService`'s sort leaves the call path's lock order unchanged. The row this control produces is a null result, not evidence of anything, and is recorded only to show the weaker control was tried and understood to be moot.<br><br>**Control B:** attempted 5 consecutive runs with both sorts removed; **no `40P01` deadlock and no 500 reproduced in any of the 5 runs** — every run passed cleanly with `{ 201: 20 }`, A = B = 30, conserved, identical to the passing result. This is a genuine null result honestly recorded, not a padded success: 20 shoppers split into two opposing fill orders was not enough contention, in these 5 runs, to force PostgreSQL into the lock-order collision this control targets. **What this PASS does, and does not, prove:** it demonstrates that no deadlock occurs under the *shipped* code (both sorts present) across 8 total attempts (3 + 5) under this harness's load. It does **not** independently prove the lock-ordering discipline in §5.4 is what prevents a deadlock that would otherwise occur — that mechanism claim remains evidenced only by the passing C3 test itself, not by a reproduced failure of its absence. No test code or `src/` change resulted; both edits were reverted by hand and confirmed via `git diff` to leave `src/` byte-identical to the committed state before re-running C3 to confirm it still passes. | 20 × 201, zero 500s, A = B = 30, conserved |
| C4 | idempotency lookup before the lock | 1 × 201, 1 × 200, 8 × 409 "Cart is empty" (vs. expected 9 × 200) | 1 × 201, 9 × 200, all replies share one `order.id`, 1 order row, stock 8, conserved |
| C5 | no cart lock (plain `tx.cart.findUniqueOrThrow` by `userId`, no upsert/lock) | 4 × 201, 6 × 409 (vs. expected 1 × 201); 4 orders created from one cart under 4 different keys. Stock itself stayed conserved (6 remaining + 4 held = 10) because `decrementStock`'s CAS is untouched by this control — the invariant this control breaks is "one cart → one order", not stock conservation | 1 × 201, 9 × 409 "Cart is empty", exactly 1 order, stock 9, conserved |
| C6 | cancel without the status predicate | All 10 cancels returned 200 (compare-and-swap always matches once there is no `PENDING` filter), stock restored 10 times instead of once: 46 instead of 10 (initial 10, checkout to 6, then +4 × 10 = +40); conservation: stock 46 + held 0 = 46 ≠ initial 10, off by 36 | 10 × 200, stock restored exactly once to 10, conserved |
| C7 | absolute stock set from a prior, non-transactional read (`findUnique` then `update`, no CAS, no `$transaction`) | All 10 checkouts returned 201 (successes = 10) — the admin's stale absolute write raced independently of `decrementStock`'s CAS and its restock effectively "refilled" stock mid-storm; final stock 4 instead of the expected `10 − successes = 0`; conservation: stock 4 + held 10 = 14 ≠ initial 5 + delta 5 = 10, off by 4 | stock = 10 − successes, no 500s, conserved with admin delta 5 |
| C8 | `findFirst` then `create` (no atomic upsert) | 5 × 200, 5 × 409 (P2002 → 409 via `HttpExceptionFilter`, vs. expected 10 × 200); 1 cart row (the DB unique constraint on `carts.user_id` still prevented a true duplicate row), only 5 cart items written | 10 × 200, exactly 1 `carts` row, 10 items |

An empty cell at review time means the corresponding claim in this spec is
unproven, and the phase is not done.

---

## 12. Definition of Done

1. One migration adds stock, three `CHECK` constraints, and four models.
2. Cart routes, order routes, checkout and cancel all behave as §6 specifies.
3. Stock can never be oversold, and C1 proves it against a recorded failing
   control.
4. Stock is conserved across checkout, cancellation and admin adjustment (§5.1),
   asserted in every concurrency test.
5. Cancellation restores stock exactly once under concurrent cancels.
6. A replayed `Idempotency-Key` returns the original order; concurrent replays
   produce exactly one order.
7. Order line prices and names are immutable against later catalog edits.
8. No external I/O occurs inside the checkout transaction.
9. `npm run lint`, `npm run build`, `npm test`, `npm run test:e2e` green; CI
   green.
10. §11 is complete, and §10's documentation updates have landed.
11. No payment code, no Redis, no BullMQ, no background job, no admin order
    route, and no new dependency.

---

## 13. Open questions

None blocking. Two items to settle during implementation, each with a stated
default so implementation is never blocked on a decision:

1. **Prisma's native upsert assumption (§5.2).** Default: test C8 proves it. If
   Prisma turns out to emit a non-atomic upsert for this shape, the fallback is
   a `$queryRaw` `INSERT … ON CONFLICT DO UPDATE` confined to
   `CartService.lockForUpdate`, and the reason gets recorded in `CLAUDE.md`.
2. **Whether `describeRefusal()` (§5.3.1) should batch** all failed products
   instead of the checkout returning on the first refusal. Default: return on the
   first failure — a shorter transaction, and one clear reason. Batching is a UX
   improvement with no correctness content, and would not change the method's
   three-value contract.
