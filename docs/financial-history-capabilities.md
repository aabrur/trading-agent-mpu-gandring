# Trading Agent Mpu Gandring financial history

Verified against official documentation on 2026-10-19. Validation used mocked HTTP, never an exchange account.

## Venue contracts

| Adapter | Read-only requests | Evidence and limits |
| --- | --- | --- |
| Aster | GET `/fapi/v3/income`, GET `/fapi/v3/userTrades` | Income provides type, transaction/trade identifiers, signed income, asset and milliseconds. Trades provide order/fill identifiers, quantity, price, position side and realized amount. Symbol is required for trades; limits reach 1000. |
| Bybit | GET `/v5/user/query-api`, GET `/v5/execution/list`, GET `/v5/account/transaction-log` | Account userID supplies scope; executions supply order/fill identifiers and fee currency. Linear UNIFIED transaction rows supply fee, cashFlow and funding. Each source has its own cursor; execution pages reach 100, transaction pages 50. |

Aster uses the adapter's existing delegated-agent signing and configured public user address, scoped with venue/network. No key permission changes. Income charges become positive costs; rebates become negative costs. Funding remains signed credit. The trade commission example has an ambiguous sign, so attribution uses matching income evidence instead. Saturated pages remain incomplete; this implementation does not guess an undocumented income cursor. Only requested managed symbols receive fill coverage. [Aster account and trades](https://asterdex.github.io/aster-api-website/futures-v3/account&trades/), [Aster signing](https://asterdex.github.io/aster-api-website/futures-v3/general-info/).

Bybit uses existing authenticated reads. Fee is positive expense or negative rebate; funding is positive receipt or negative payment. cashFlow excludes those costs. Buy/Sell identifies execution direction, not a proven held-position side. Both history queries accept at most seven days per request. [Transactions](https://bybit-exchange.github.io/docs/v5/account/transaction-log), [executions](https://bybit-exchange.github.io/docs/v5/order/execution), [public account identity field](https://bybit-exchange.github.io/docs/v5/user/apikey-info).

## Application accounting rules

- Optional capability: other adapters remain unsupported without affecting order support.
- Scope is a hash of venue/network/public identity, never secret material. A detected account mismatch invalidates summaries and remains persisted. Existing evidence is retained; replacing accounts requires a separately reviewed fresh ledger, never automatic merging.
- Dedupe uses source kind, symbol and source identifier. Incomplete pagination, malformed responses and missing fee/currency evidence produce unknown, not zero. Known unmatched fill fees supplement ledger costs without counting the same fill twice.
- Reports separate account-wide USDT fees/funding from managed-position net. Foreign currencies are retained without conversion. Complete empty cost coverage can confirm zero.
- Managed net requires exact order/client identifiers, full entry and exit quantities, actual costs, known entry and complete lifecycle coverage. Nonzero funding with ambiguous position attribution keeps net unknown. No local exit, balance, score, risk baseline or fill history is fabricated.
- Refresh is single-flight and read-only at report generation, outside the execution/reconciliation lock. Report state is captured before history awaits. Orders never await history; report delivery may await adapter timeouts and up to 20 pages. Existing report scheduling is unchanged.
- Queries cover at most seven days. Older or unavailable lifecycle evidence stays unknown. Evidence is retained atomically beside the execution journal and ignored by Git. There is no claim of unlimited venue retention; automatic archival is not implemented because open-lifecycle evidence must survive.

The report-triggered read is an intentional deviation from the plan's suggested reconciliation trigger: it avoids adding history traffic to every position reconciliation and retrieves the report's exact requested window. No extra permanent scheduler is introduced.
