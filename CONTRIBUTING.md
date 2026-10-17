# Contributing

Thanks for wanting to help with Trading Agent Mpu Gandring.

## Before you open a pull request

1. `npm install`
2. `npm test` passes.
3. `npm run build` passes.
4. If you touched the UI, run `npm run dev`, check it in a browser, and attach a screenshot.

## What we welcome

- New model providers (keep keys server side and add a test with a fake caller).
- Better agent personalities and prompts.
- New market data sources that need no key.
- UI polish, accessibility fixes, translations.
- More tests, especially around risk caps and injection.

## What we will not merge

- Withdrawal, transfer or wallet-key handling code. Changes that weaken the LIVE unlock, skip the risk gate, or retry live orders blindly.
- New exchange adapters without tests against mocked HTTP. Mark them experimental in `server/exchange/types.ts` until someone has run the testnet round trip.
- Anything that loosens the code caps in `server/risk.ts` or `server/money.ts` by default.
- Code that sends API keys to the browser or prints them in logs.
- Profit claims in docs or UI copy.

## Style

- TypeScript, strict mode.
- Keep agent replies as JSON validated by a schema in `server/schemas.ts`.
- Write docs in plain language. Short sentences. No hype.
- The project name is "Trading Agent Mpu Gandring". Please do not introduce other product names.

## Commit messages

Short summary line in the imperative ("Add OKX market data"), then a blank line and details if needed.
