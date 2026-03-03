# I Built an Analytics API
---

## Let's Start With the Problem Everyone Ignores

Imagine you run a company with 500 employees. Someone asks: *"What's the average salary in the engineering department?"*

You run the query. The result comes back: **$121,432**.

Now they ask again, but this time filtering out just one specific person: *"What's the average salary in engineering, excluding Alice?"*

Result: **$119,847**.

With two innocent-looking queries, they've just calculated Alice's exact salary. No hacking. No breach. Just math.

This is called a **linkage attack**, and it's devastatingly simple. Normal databases have zero protection against it. Row-level security doesn't help. Encryption doesn't help. Access controls don't help. The data leaks through the *answers themselves*.

This is the problem I set out to solve.

---

## The Core Idea: Controlled, Calibrated Noise

The solution is counterintuitive: **give people slightly wrong answers, on purpose.**

Not random garbage — carefully calibrated noise that's just enough to make individual-level inference impossible, but small enough that the aggregate trends are still completely useful.

This is the foundation of **Differential Privacy (DP)**, a mathematical framework originally developed at Microsoft Research. The key insight is:

> *The result of any query should look roughly the same whether or not any single person's data is included in the dataset.*

If Alice's data being in or out of the database doesn't meaningfully change the result you see, then the result can't tell you anything about Alice.

---

## How the Noise Actually Works

There are two noise mechanisms in the system, each suited to different kinds of queries.

**The Laplace Mechanism** (for counting things)

When you ask "how many users are in each age group?", the true answer might be 47. Instead of returning 47, the system adds a small random amount sampled from a bell-curve-like distribution called the Laplace distribution. You might get 49, or 44, or 51. The width of that distribution is controlled by one number: **ε (epsilon)**, the privacy budget.

Small ε → more noise → stronger privacy guarantee  
Large ε → less noise → more accurate results, weaker privacy

The exact formula for how wide to make the noise is `sensitivity / ε`, where "sensitivity" is the maximum possible effect a single person could have on the query result. For a COUNT query, one person can change the result by at most 1, so sensitivity = 1.

**The Gaussian Mechanism** (for averages, sums, revenue)

For aggregate queries like "what's the average salary?", the Laplace mechanism isn't the best fit — the Gaussian (normal distribution) mechanism gives tighter guarantees. The math is slightly more complex and introduces a second small parameter **δ (delta)** that represents an astronomically small probability that the guarantee breaks down. In practice, δ is set to something like 0.00001.

Both mechanisms are implemented from scratch using proper statistical sampling — Box-Muller transform for Gaussian, inverse CDF method for Laplace. No black boxes.

---

## The Budget System: Privacy Has a Cost You Can Actually Measure

Here's where things get interesting.

One noisy result might be safe. But what about 1,000 noisy results? If someone asks the same query hundreds of times with slightly different filters, they can average out the noise and reconstruct the true value.

This is called **composition** — privacy budgets accumulate. Every query you run costs some amount of ε. Run enough queries and you've effectively spent your entire privacy budget, and the system stops answering you.

Each user gets a total budget of **ε = 10** per day. Every query declares upfront how much ε it wants to use. The system checks atomically:

1. Does this user have enough ε remaining?
2. If yes — deduct it and run the query
3. If no — reject with HTTP 429 (Too Many Requests)

The "atomically" part is critical. This lives in Redis, and the check-and-deduct is written as a **Lua script** that runs as a single atomic operation on the Redis server. This prevents a race condition where two simultaneous requests both see "budget available," both get approved, and together they exceed the limit.

After your daily budget resets, you start fresh.

---

## The Query Whitelist: Bounding the Unknown

There's a subtlety that most DP tutorials gloss over: you need to know the **sensitivity** of a query before you can calibrate the noise correctly.

For "COUNT the rows" — sensitivity is always 1 (one person = one row).  
For "SUM of salaries" — sensitivity is the maximum possible salary (if one person earns $500k, they can swing the sum by $500k).  
For "AVERAGE" — it gets more complex.

If users could write arbitrary SQL, calculating sensitivity becomes an unsolved research problem. So the system takes a practical approach: **no arbitrary SQL**. There are five pre-approved query templates, each with a hand-verified sensitivity value baked in:

- Count users by age group (sensitivity: 1)
- Average salary by department (sensitivity: $50,000)
- Daily event counts (sensitivity: 1)
- Purchase totals by category (sensitivity: $1,000)
- User cohort retention (sensitivity: 1)

Users pick a template, supply an ε, choose a mechanism, and get back noisy results. This isn't a limitation — it's the correct engineering tradeoff. Arbitrary queries break the math.

---

## The Audit Log: Proof That It Happened

Every query — successful or rejected — gets written to a **Kafka topic** called `dp-audit-log`. The record includes:

- Who made the query (user ID)
- Which query template they used
- A SHA-256 hash of the query (not the raw SQL — the hash is enough to prove what ran without storing sensitive schema details)
- What mechanism was used and with what parameters
- How much budget was consumed, and what remained before and after
- The outcome (success / budget exceeded / error)

This creates an **immutable, append-only audit trail** that a privacy officer can inspect at any time to verify that the system is behaving correctly. If you ever need to answer the question "did user X have enough information, over time, to reconstruct person Y's salary?" — the Kafka log gives you everything needed to compute the exact composed privacy loss.

This is what's meant by a **privacy accountant**. Not a person — a mathematical accounting of how much privacy has been spent, by whom, and on what.

---

## The Architecture in Plain English

```
Your request
    ↓
Bun HTTP server (fast, TypeScript-native runtime)
    ↓
Check Redis: does this user have enough ε budget?
    ↓ (if yes, atomically deduct it)
Run the pre-approved SQL query against PostgreSQL
    ↓
Get back the true result (this never leaves the server)
    ↓
Add calibrated Laplace or Gaussian noise
    ↓
Write audit record to Kafka (fire-and-forget, doesn't slow the response)
    ↓
Return the noisy result to the caller
```

The caller never sees the true value. The noise is applied server-side, in memory, before the result is serialized into the HTTP response. Even if someone wiretapped the connection, they'd only see the noisy answer.

---

## What This Looks Like to Call

```bash
# Ask for user counts by age group, spending ε=1 of your budget
curl -X POST http://localhost:3000/query \
  -H "X-User-ID: alice_1" \
  -H "Content-Type: application/json" \
  -d '{"query": "count_users_by_age", "epsilon": 1.0, "mechanism": "laplace"}'
```

Response:
```json
{
  "ok": true,
  "data": [
    { "age_group": "18-24", "user_count": 7 },
    { "age_group": "25-34", "user_count": 9 },
    { "age_group": "35-44", "user_count": 5 }
  ],
  "meta": {
    "mechanism": "laplace",
    "epsilon_used": 1.0,
    "budget_remaining": 9.0,
    "dp_guarantee": "ε-DP with ε=1",
    "row_count": 5
  }
}
```

Those user counts are noisy. The real counts might be 6, 8, and 6. But the trends are preserved and no individual record can be reconstructed from this response.

---

## What This Is *Not*

This is not encryption. Encryption protects data at rest or in transit.  
This is not anonymization. Anonymization is famously breakable via re-identification.  
This is not access control. Access control decides *who* can see data, not *what* the data reveals.

Differential Privacy is the only technique that provides a **formal, mathematical upper bound** on what information can be extracted from a system's outputs, regardless of what other information an adversary already has.

---

## The Tradeoffs (Being Honest)

No engineering decision is free. Here's what you give up:

**Accuracy degrades for small populations.** If you're counting events in a group of 3 people, adding Laplace noise with scale 1 can make the answer off by ±3 or more. DP works best when aggregating over large populations.

**ε is hard to explain to non-engineers.** Setting ε=1 vs ε=0.1 is a policy decision with real consequences, and communicating what those mean to stakeholders requires care.

**The budget resets daily, which is a simplification.** A production system would want more sophisticated composition — techniques like Rényi DP or zero-concentrated DP — to get tighter budget accounting across multiple query types.

**Pre-approved queries limit flexibility.** That's the point, but teams used to ad-hoc SQL will feel the friction.

---

## Why This Matters

Regulation like GDPR says you must protect personal data. It doesn't tell you *how*. Most teams answer that with access controls and legal agreements.

Differential Privacy answers it with math.

As more analytics platforms move toward privacy-preserving computation — Apple uses DP for telemetry, Google uses it for Chrome data collection, the US Census Bureau used it for the 2020 census — understanding how to build these systems becomes a real engineering skill, not an academic curiosity.

This project is a full working implementation in about 400 lines of TypeScript. Every component is real: the noise sampling is from-scratch, the budget accounting is race-condition-safe, the audit trail is durable. It's not a toy.

---

## Stack Summary

| Layer | Technology | Why |
|-------|-----------|-----|
| Runtime | Bun + TypeScript | Fast startup, native TS, great for HTTP servers |
| Privacy math | Custom implementation | Laplace (inverse CDF) + Gaussian (Box-Muller) |
| Budget tracking | Redis + Lua scripts | Atomic check-and-deduct, sub-millisecond |
| Audit logging | Kafka | Append-only, durable, partitioned by user ID |
| Data store | PostgreSQL | Standard analytics database |

---

The source is 9 files. The math goes back to a 2006 paper by Dwork, McSherry, Nissim, and Smith. The idea that you can *prove* privacy rather than just promise it is one of the most elegant results in modern computer science — and it turns out you can build a working version of it in a weekend.

---

*Built with Bun, TypeScript, PostgreSQL, Redis, and Kafka. Questions welcome.*