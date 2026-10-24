# Intelligence provider coverage

Trading Agent Mpu Gandring reports public-provider observations as evidence with limits. An empty event list is meaningful only when the provider request succeeded; it must not be read as proof that no event happened outside that feed or window.

| Feed | Configuration | Result states | Coverage |
| --- | --- | --- | --- |
| Bybit announcements | Public V5 announcement endpoint | `DATA_AVAILABLE`, `NO_RELEVANT_EVENTS`, `UNAVAILABLE` | Up to 50 recent announcements, symbol matched and limited to the last 72 hours. Uses the provider's `publishTime` where supplied, with `dateTimestamp` fallback. Announcements are reported claims. |
| Whale Alert transactions | `WHALE_ALERT_API_KEY` | `DATA_AVAILABLE`, `NO_RELEVANT_EVENTS`, `UNCONFIGURED`, `UNAVAILABLE` | The existing collector still calls the legacy `api.whale-alert.io/v1/transactions` route. Current official docs describe subscription-gated APIs with a different `/transactions` contract. The current docs do not confirm this legacy route, its 24-hour query, or its $500,000 threshold. Treat live compatibility and entitlement as unverified. Responses are capped at 10 unique hashes; missing values remain unknown. |
| Hyperliquid account positions | Optional comma-separated `HYPERLIQUID_WHALE_ADDRESSES`; the existing built-in sample list is used only when unset | `DATA_AVAILABLE`, `NO_RELEVANT_EVENTS`, `PARTIAL`, or unavailable (`undefined`) | Only queried addresses and perpetual positions returned by `clearinghouseState`; reports whether the watchlist was configured or built-in sample, plus queried/requested coverage. It is not market-wide positioning. Invalid and duplicate addresses are excluded; a present but entirely invalid setting does not fall back to the sample list. |
| Sui GraphQL Move events | Optional HTTPS `SUI_GRAPHQL_URL`; optional validated `SUI_SENDER_ADDRESS` filter | `DATA_AVAILABLE`, `NO_RELEVANT_EVENTS`, `UNCONFIGURED`, `UNAVAILABLE` | Up to 50 recent indexed Move events from the endpoint. Without the sender filter this is a recent sample. It is not a token-transfer feed, full-chain coverage, or evidence of selling intent. Events deduplicate by transaction digest and event sequence number. |

Provider request success and event relevance are separate. `observedAt` is ingestion time, not a substitute for a missing publication or transaction time. A provider error is not an empty event result. Bybit items add `observedAt`, `affectedAssets`, `eventCategory`, and `evidenceStatus` without changing the shared `NewsItem` contract. Duplicate announcement IDs, Whale Alert hashes, and Sui digest/event-index pairs are removed within each bounded response.

## Official API references

- [Bybit V5 Get Announcement](https://bybit-exchange.github.io/docs/v5/announcement) documents the public endpoint and `publishTime` field.
- [Whale Alert API documentation](https://developer.whale-alert.io/api-account/documentation) documents subscription-dependent API access, transaction responses, and alert subscriptions.
- [Hyperliquid Info endpoint](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) documents POST requests to `/info` and `clearinghouseState` wallet queries.
- [Sui data access interfaces](https://docs.sui.io/develop/accessing-data/data-serving) documents GraphQL and gRPC as current data interfaces. The [Sui GraphQL migration cookbook](https://docs.sui.io/develop/accessing-data/graphql/graphql-migration-cookbook) documents `Query.events`, `EventFilter`, `transaction { digest }`, `sequenceNumber`, `timestamp`, and `contents { type { repr } json }`. [Sui GraphQL RPC](https://docs.sui.io/develop/accessing-data/graphql/graphql-rpc) notes service/configuration and endpoint considerations.

Fixture tests prove parsing and state classification only. They do not prove current credentials, provider reachability, subscription entitlements, historical completeness, or production coverage.
