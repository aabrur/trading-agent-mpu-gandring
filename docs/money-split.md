# Trading Agent Mpu Gandring: money split

Set by Boss (Abrur Alaina) on 2026-10-17. In this repository it runs on the paper book.

```
Money Trade          = Total balance - Safety net
Allocation per order = Money Trade / N        (N = 1, 2, 3 or 4, the owner picks)
```

Example: balance 100 USDT, safety net 20 USDT, N = 4. Money Trade is 80 USDT, so each order gets 20 USDT of margin.

- Recompute from the current balance before every new order, and after every close.
- Never more than N open positions. Never touch the safety net.
- If an allocation is below the minimum order (or buys less than one lot step), do not round up. Say so and suggest a smaller N.
- The per-trade loss cap still applies. The stricter limit wins.
- If balance is at or below the safety net, stop opening orders and say so.

Code: `server/money.ts`. Tests: `tests/money.test.ts`.
