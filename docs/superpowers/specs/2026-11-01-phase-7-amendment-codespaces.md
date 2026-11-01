# Phase 7 amendment — the host changed, and the objective did not

**Date:** 2026-11-01
**Amends:** [`2026-10-29-phase-7-public-demo-deployment-design.md`](2026-10-29-phase-7-public-demo-deployment-design.md)
**Status of the original objective:** **NOT FULFILLED.** See §6.

The original spec names **Render** as the compute host throughout. Render was
never provisioned. This amendment records what blocked it, what was deployed
instead, what that substitution proves, and — more importantly — what it does
not. The original document is left intact rather than edited, so the record
shows the plan that was made and the plan that survived contact.

---

## 1. Why Render was abandoned

The Render service was configured to completion: repository `mohatab/ecommerce-backend`
on `master`, Docker runtime, Frankfurt (EU Central), **Free** instance type,
`PORT=3000`, health check path `/health/live`, Auto-Deploy **Off**, and all ten
environment variables entered. Pressing **Deploy web service** produced a modal
titled **Add Card**, whose own text reads:

> To verify your card, Render will perform a temporary authorization for $1 USD.
> You won't be charged.

Render will not create **any** service, free tier included, without a verified
payment card. The operator's card was declined, and entering card details is
outside what the assistant performs under any authorization. No service was
created and nothing was charged.

## 2. Why Hugging Face Spaces was abandoned

Spaces was selected next on the strength of its Docker documentation (arbitrary
`Dockerfile`, `app_port` to move off the 7860 default, runtime secrets from a
settings tab) and a pricing page listing **CPU Basic — FREE**. The pricing page
does not mention the gate. The Space creation form does:

> **Gradio and Docker Spaces require a paid plan.** Static Spaces stay free for
> everyone. To create a Space that runs on compute, subscribe to PRO.

Free Spaces are static hosting only. Anything that runs a container requires
PRO, which requires a card. **This was a research failure, not a platform
change discovered late:** the capability was confirmed from documentation and
the *entitlement* was not. A deployment target needs both checked before it is
written into a plan.

## 3. What was actually deployed

A **GitHub Codespace** running the repository's own image.

| Property | Value | Source |
| --- | --- | --- |
| Codespace | `phase7-demo-94r7xrj7rqq37qjx` | `gh codespace list` |
| Machine | `basicLinux32gb` — 2 cores, 8 GB RAM, 32 GB storage | `gh api user/codespaces/<name>` |
| Region | `WestEurope` | same |
| Idle timeout | **30 minutes** (`idle_timeout_minutes: 30`) | same |
| Retention when stopped | **43200 minutes = 30 days** (`retention_period_minutes`) | same |
| Commit deployed | `a84aca7076f8915608071d1ae46dceb89f44cae3` (`master`) | `git rev-parse HEAD` in the codespace |
| Image | `sha256:bbcb35cb194f4f3168ba8cc6e3b17031071aca19ebc98cc14cd7aea865b4bf59` | `docker inspect` |
| Public URL | `https://phase7-demo-94r7xrj7rqq37qjx-3000.app.github.dev` | `gh codespace ports` |
| Database | unchanged — Neon `ecommerce-backend` (`crimson-dew-74341531`), `aws-eu-central-1` | `neon projects list` |

### Included usage, computed rather than quoted

GitHub Free personal accounts include **120 core-hours per month** and 15 GB-month
of storage, and core-hours scale with machine size. On this 2-core machine that
is **60 wall-clock hours per month**, not 60 core-hours — an earlier working note
in this project stated the figure incorrectly and is corrected here.

### Port behaviour, observed

The forwarded port is **not** public by default, and publishing it is not
permanent. During the rollback drill (§5), with no process listening on 3000,
the public URL returned **401** from GitHub's forwarding layer rather than a
5xx from the application. A reader must not treat the URL as a stable endpoint:
it serves only while the codespace runs, the container listens, **and** the port
has been explicitly set to `public`.

## 4. Acceptance criteria that changed

| Original criterion | Disposition |
| --- | --- |
| Platform health check on `/health/live`, 5-second budget | **N/A.** Codespaces has no configurable probe. Evidence is stronger instead: Docker's own `.State.Health.Status` plus the registered `.Config.Healthcheck.Test` string |
| Service co-located with the database in Frankfurt | **Partially met.** Codespace is `WestEurope`, Neon is `aws-eu-central-1`. Same continent, not the same region. Latency only |
| Free-tier spin-down behaviour (15 min, ~1 min restore) | **Replaced** by a 30-minute idle stop and a manual reopen (`gh codespace ssh`, `gh codespace code`, or the browser — there is no `start` subcommand) |
| Always-on public HTTPS demo | **NOT MET.** See §6 |
| `TRUST_PROXY_HOPS` measured on the deployment | **Met, scoped.** Measured behind GitHub's forwarding proxy. The value is a property of that topology and transfers to no other host |

## 5. Evidence, stated at its true strength

Full results are in the plan's execution record. Three claims need their limits
attached, because each is weaker than a casual reading suggests.

**The webhook was verified at the application level, not end-to-end from Stripe.**
A real Stripe sandbox destination was created (`ecommerce-backend-phase7-demo`,
snapshot payload, `payment_intent.succeeded`), and its **real signing secret**
was configured on the deployment. What passed was **five delivery scenarios**
(missing signature, tampered signature, amount mismatch, valid event, replayed
event) carrying **ten assertions** — five on the HTTP response status and five
read-backs of the order's database state. That is not ten independent probes.
Every event was **synthetically constructed and signed locally** with that
secret against a genuine PaymentIntent created by the API. **No delivery originating from
Stripe's own infrastructure was observed reaching the endpoint.** What is proven
is that the endpoint accepts a correctly signed event, rejects a tampered one,
rejects an unsigned one, returns 200 rather than 4xx on an amount mismatch, and
deduplicates a replay. What is **not** proven is Stripe's delivery path, its
retry behaviour, or its TLS negotiation against this host.

**The Stripe API version diverges.** The destination delivers `2026-10-28.endive`;
`stripe-payment.provider.ts` pins `2026-08-26.dahlia` for outbound calls. The
sandbox offers no older version to select. Verified scope: the handler reads
`event.data.object.id`, `.amount`, `.currency` and `.metadata.orderId`, all of
which were present and correctly typed in `endive` payloads. Any field outside
that set is unverified across the version gap.

**The journey ran against the public URL, on a database that was not fresh.**
Tasks 2a/2b had already populated it. Counts at the time of the rollback drill:
4 users, 3 products, 3 orders, 1 paid, 3 payments, 2 payment events.

## 6. The original objective remains open

Phase 7's stated goal was *"a real public HTTPS portfolio demo"* — an endpoint a
recruiter can open without coordination. **That has not been delivered.** What
exists is an on-demand environment the operator must start, whose port must be
re-published, which stops itself after 30 minutes idle, and which consumes a
metered monthly allowance while running.

This is **not** a hosting solution and must not be described as one in the README,
in a CV, or to an interviewer. It is a reproducible demonstration environment.

**Stable, always-accessible public HTTPS hosting is carried forward as an open
deployment requirement**, recorded in `docs/deferred-limitations.md`.

What the evidence actually supports, by tier:

| Provider | Status | Basis |
| --- | --- | --- |
| **Render** | Card required, **directly observed** | Its own Add Card modal blocked creation of a Free service (§1) |
| **Hugging Face Spaces** | Paid plan required, **directly observed** | The Space creation form states Docker Spaces are PRO-only (§2) |
| **Fly.io** | No free tier for new organisations, **verified from official documentation** in an earlier session | Fly.io pricing docs |
| **Koyeb** | **UNVERIFIED** | Its billing documentation returned HTTP 404 on every attempt; third-party sources from 2026 conflict over a card requirement |
| **Railway**, **Google Cloud Run**, **Oracle Cloud** | **NOT VERIFIED in this review** | Mentioned only in third-party roundups; no official page was read |

**No claim is made that every provider requires a card or a paid plan.** Two
were observed to, one is documented to lack a free tier, and the rest were not
checked against official sources. A future attempt should begin by verifying
entitlement — not merely capability — for Koyeb, Railway, Cloud Run and Oracle
before any further configuration work.
