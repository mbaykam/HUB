# Provider usage

Open **Settings → HUB → Usage** to check connected providers. The panel refreshes
while open; tap its refresh button to request another reading. API keys stay on
the HUB host. The PWA receives only usage and balance figures.

**Unlid** shows available credit, reservations for active requests, account
balance, this month's spend and lifetime totals. Available credit subtracts
reservations from the balance. These are account totals, including activity
outside HUB. Small charges remain visible instead of rounding to zero.

**Soniox** shows today's, the last seven days' and this month's costs, plus monthly
request counts and audio durations. Expand **By model** for the monthly breakdown.
These are project totals, including other apps using that Soniox project. Days
use UTC and active sessions appear after they finish. Open **Soniox billing**
for the remaining credit balance.

A provider connection error appears on its own card. Other connected providers
remain available. An unavailable reading is not displayed as zero usage. If no
Soniox key is saved, connect it in **Settings → HUB → Speech**.

Provider references: [Unlid account and credit API](https://unlid.ai/docs),
[Soniox usage summary](https://soniox.com/docs/sdk/python-SDK/Full-SDK-reference/async_client#asyncusageapi).
