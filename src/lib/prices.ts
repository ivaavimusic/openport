// Pricing via public APIs — no key required, which keeps the default setup
// free. CoinGecko is the primary source because it returns prices and logos in
// one call. DefiLlama and CoinMarketCap are spot-price fallbacks for the times
// a public API flakes out or rate-limits. History still uses CoinGecko because
// it is non-critical and cached for a day.

const CG = 'https://api.coingecko.com/api/v3';
const LLAMA = 'https://coins.llama.fi';
const CMC = 'https://pro-api.coinmarketcap.com/public-api';
const SPOT_TTL_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;

const STABLE_USD_FALLBACKS: SpotPrices = {
    dai: 1,
    tether: 1,
    'usd-coin': 1,
};

// CoinMarketCap supports slug lookup on its keyless endpoint. Keep this
// explicit so symbol collisions do not price the wrong asset.
const CMC_SLUG_BY_COINGECKO_ID: Record<string, string> = {
    arbitrum: 'arbitrum',
    bitcoin: 'bitcoin',
    dai: 'multi-collateral-dai',
    ethereum: 'ethereum',
    hyperliquid: 'hyperliquid',
    solana: 'solana',
    tether: 'tether',
    'usd-coin': 'usd-coin',
    weth: 'weth',
    'wrapped-bitcoin': 'wrapped-bitcoin',
};

export type SpotPrices = Record<string, number>;
/** [unixMs, usd] ascending. */
export type PriceSeries = [number, number][];

interface Cached<T> {
    at: number;
    data: T;
}

function readCache<T>(key: string, ttl: number): T | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const c = JSON.parse(raw) as Cached<T>;
        if (Date.now() - c.at > ttl) return null;
        return c.data;
    } catch {
        return null;
    }
}

function writeCache<T>(key: string, data: T): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(
            key,
            JSON.stringify({ at: Date.now(), data } satisfies Cached<T>),
        );
    } catch {
        /* quota exceeded is not fatal */
    }
}

export interface MarketData {
    prices: SpotPrices;
    /** CoinGecko id -> logo URL. Free: same response as the prices. */
    images: Record<string, string>;
}

function hasPrice(data: MarketData, id: string): boolean {
    return typeof data.prices[id] === 'number' && Number.isFinite(data.prices[id]);
}

function missingPriceIds(ids: string[], data: MarketData): string[] {
    return ids.filter((id) => !hasPrice(data, id));
}

async function fetchDefiLlamaPrices(ids: string[]): Promise<SpotPrices> {
    const unique = Array.from(new Set(ids.filter(Boolean))).sort();
    if (unique.length === 0) return {};

    try {
        const coins = unique.map((id) => `coingecko:${id}`).join(',');
        const res = await fetch(
            `${LLAMA}/prices/current/${encodeURIComponent(coins)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
            coins?: Record<string, { price?: number }>;
        };

        const out: SpotPrices = {};
        for (const id of unique) {
            const price = json.coins?.[`coingecko:${id}`]?.price;
            if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
                out[id] = price;
            }
        }
        return out;
    } catch {
        return {};
    }
}

async function fetchCoinMarketCapPrices(ids: string[]): Promise<SpotPrices> {
    const slugToId = new Map<string, string>();
    for (const id of ids) {
        const slug = CMC_SLUG_BY_COINGECKO_ID[id];
        if (slug) slugToId.set(slug, id);
    }
    const slugs = Array.from(slugToId.keys()).sort();
    if (slugs.length === 0) return {};

    try {
        const qs = new URLSearchParams({
            slug: slugs.join(','),
            convert: 'USD',
        });
        const res = await fetch(`${CMC}/v2/simple/price?${qs.toString()}`, {
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
            data?: {
                slug?: string;
                quotes?: { symbol?: string; price?: number }[];
            }[];
        };

        const out: SpotPrices = {};
        for (const row of Array.isArray(json.data) ? json.data : []) {
            const id = row.slug ? slugToId.get(row.slug) : undefined;
            const price = row.quotes?.find((q) => q.symbol === 'USD')?.price;
            if (
                id &&
                typeof price === 'number' &&
                Number.isFinite(price) &&
                price > 0
            ) {
                out[id] = price;
            }
        }
        return out;
    } catch {
        return {};
    }
}

async function fillMissingSpotPrices(
    ids: string[],
    data: MarketData,
): Promise<MarketData> {
    const prices = { ...data.prices };
    const images = { ...data.images };
    let missing = missingPriceIds(ids, { prices, images });

    if (missing.length > 0) {
        Object.assign(prices, await fetchDefiLlamaPrices(missing));
        missing = missingPriceIds(ids, { prices, images });
    }

    if (missing.length > 0) {
        Object.assign(prices, await fetchCoinMarketCapPrices(missing));
        missing = missingPriceIds(ids, { prices, images });
    }

    for (const id of missing) {
        const price = STABLE_USD_FALLBACKS[id];
        if (price !== undefined) prices[id] = price;
    }

    return { prices, images };
}

/**
 * Spot price *and* logo for each CoinGecko id in a single request.
 *
 * /coins/markets costs exactly what /simple/price did but also carries the
 * icon, so token logos are free rather than a second round of lookups. Public
 * price APIs can be intermittent, so missing prices are filled from fallback
 * sources before the result is cached.
 */
export async function fetchMarketData(ids: string[]): Promise<MarketData> {
    const unique = Array.from(new Set(ids.filter(Boolean))).sort();
    if (unique.length === 0) return { prices: {}, images: {} };

    const key = `openport-mkt:${unique.join(',')}`;
    const cached = readCache<MarketData>(key, SPOT_TTL_MS);
    if (cached && missingPriceIds(unique, cached).length === 0) return cached;

    let out: MarketData = cached ?? { prices: {}, images: {} };
    try {
        const url = `${CG}/coins/markets?vs_currency=usd&ids=${unique.join(
            ',',
        )}&per_page=250&sparkline=false`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as {
            id: string;
            current_price?: number;
            image?: string;
        }[];

        out = { prices: { ...out.prices }, images: { ...out.images } };
        for (const row of Array.isArray(json) ? json : []) {
            if (
                typeof row.current_price === 'number' &&
                Number.isFinite(row.current_price)
            ) {
                out.prices[row.id] = row.current_price;
            }
            if (row.image) out.images[row.id] = row.image;
        }
    } catch {
        // Fallbacks below keep balances useful during public API outages.
    }

    out = await fillMissingSpotPrices(unique, out);
    writeCache(key, out);
    return out;
}

/**
 * USD prices for tokens by contract/mint address on a CoinGecko platform.
 *
 * Preferred over a single DEX quote where the token is listed: CoinGecko
 * aggregates across venues, whereas a DEX price reflects one pool's liquidity.
 * Batched, so this is one request however many addresses are held.
 */
export async function fetchTokenPricesByContract(
    platform: string,
    addresses: string[],
): Promise<Record<string, number>> {
    const unique = Array.from(new Set(addresses.filter(Boolean))).sort();
    if (unique.length === 0) return {};

    const key = `openport-cgcontract:${platform}:${unique.join(',')}`;
    const cached = readCache<Record<string, number>>(key, SPOT_TTL_MS);
    if (cached) return cached;

    try {
        const url =
            `${CG}/simple/token_price/${platform}` +
            `?contract_addresses=${unique.join(',')}&vs_currencies=usd`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Record<string, { usd?: number }>;

        const out: Record<string, number> = {};
        // CoinGecko lowercases addresses it echoes back; Solana mints are
        // case-sensitive, so map results onto the addresses we asked for.
        const byLower = new Map(unique.map((a) => [a.toLowerCase(), a]));
        for (const [addr, v] of Object.entries(json ?? {})) {
            const original = byLower.get(addr.toLowerCase()) ?? addr;
            if (typeof v?.usd === 'number' && v.usd > 0) out[original] = v.usd;
        }
        writeCache(key, out);
        return out;
    } catch {
        return {};
    }
}

/** Daily USD series for the last year. */
export async function fetchPriceHistory(id: string): Promise<PriceSeries> {
    if (!id) return [];
    const key = `openport-hist:${id}`;
    const cached = readCache<PriceSeries>(key, HISTORY_TTL_MS);
    if (cached) return cached;

    const url = `${CG}/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`History lookup failed (HTTP ${res.status})`);
    const json = (await res.json()) as { prices?: [number, number][] };
    const series = json.prices ?? [];
    writeCache(key, series);
    return series;
}

/** Fetch several histories, tolerating individual failures. */
export async function fetchHistories(
    ids: string[],
): Promise<Record<string, PriceSeries>> {
    const unique = Array.from(new Set(ids.filter(Boolean)));
    const entries = await Promise.all(
        unique.map(async (id) => {
            try {
                return [id, await fetchPriceHistory(id)] as const;
            } catch {
                return [id, [] as PriceSeries] as const;
            }
        }),
    );
    return Object.fromEntries(entries);
}

/** Bucket a series to one price per UTC day. */
export function toDailyMap(series: PriceSeries): Map<string, number> {
    const m = new Map<string, number>();
    for (const [t, p] of series) {
        m.set(new Date(t).toISOString().slice(0, 10), p);
    }
    return m;
}
