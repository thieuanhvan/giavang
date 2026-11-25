# giavang

One-page dashboard of Vietnamese and world gold prices at https://giavang.thieuanhvan.com.

- `src/worker.js`: Cloudflare Worker. A cron trigger runs every hour (minute 5), fetches prices and stores them in the KV namespace `GIA`; the page reads them from `/api/data`.
- `public/index.html`: the page (Chart.js from cdnjs).
- Sources, all free without a key: vang.today (Vietnamese brands, world XAU/USD, one year of daily history used to fill the chart on the first run), the PNJ price board, the Vietcombank USD rate (fallback open.er-api.com).

Local run: `npx wrangler dev --test-scheduled`, then open `/__scheduled` to run the cron once.

Deploy: connect this repo to a Cloudflare Worker (Workers & Pages → Create → Import a repository). Build command empty, deploy command `npx wrangler deploy`. Wrangler creates the KV namespace and the custom domain `giavang.thieuanhvan.com` on the first deploy.

Prices are for reference only.
