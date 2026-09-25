// Portfolio orchestration: fetch per chain, aggregate, price, build the chart.
//
// A chain that fails is recorded as failed and excluded from the total. It is
// never rendered as $0 — an incomplete total with a warning is far safer than
// a confidently wrong one.

import { CHAINS, ChainConfig, getSupportedChains } from './chains';
import { CachedPortfolio, Settings, Wallet } from './settings';
import { buildEvmClient, resolveRpcs } from './rpc';
import { fetchEvmBalances, toDecimal, RawBalance } from './evm';
import { fetchSolanaBalances } from './solana';
import { fetchHyperCoreBalances } from './hyperliquid';
import { fetchBitcoinBalances } from './bitcoin';
import { fetchMarketData, fetchHistories, toDailyMap } from './prices';

export interface AssetRow {
    symbol: string;
    quantity: number;
    usd: number;
    weight: number;
    priced: boolean;
    coingeckoId?: string;
    /** Token logo URL, when CoinGecko supplied one. */
    icon?: string;
}

export interface WalletRow {
    wallet: Wallet;
    chains: string[];
    usd: number;
}

export type ChainState =
    | 'ok'
    | 'degraded'
    | 'failed'
    | 'unreachable'
    | 'unsupported';

export interface ChainStatus {
    chainId: string;
    state: ChainState;
    message?: string;
}

export interface PortfolioResult {
    balances: RawBalance[];
    assets: AssetRow[];
    wallets: WalletRow[];
    totalUsd: number;
    chainStatus: ChainStatus[];
    fetchedAt: number;
    mode: 'alchemy' | 'public';
    /** Spot prices by CoinGecko id, retained so filtering can re-aggregate. */
    spot: Record<string, number>;
    /** Token logos by CoinGecko id, retained for the same reason. */
    images: Record<string, string>;
    /** True when any chain failed, so the total is known to be incomplete. */
    incomplete: boolean;
    /** Wallet id -> why that specific wallet could not be read. */
    walletIssues: Record<string, string>;
}

export interface Aggregated {
    assets: AssetRow[];
    wallets: WalletRow[];
    totalUsd: number;
}

/**
 * Roll raw balances up into asset and wallet rows. Pure, so the UI can call it
 * again with a chain-filtered slice without refetching anything.
 */
export function aggregate(
    balances: RawBalance[],
    spot: Record<string, number>,
    wallets: Wallet[],
    images: Record<string, string> = {},
): Aggregated {
    const bySymbol = new Map<string, AssetRow>();
    for (const b of balances) {
        const qty = toDecimal(b.amount, b.decimals);
        if (qty === 0) continue;
        // CoinGecko id first, then any price the source resolved itself.
        const price = b.coingeckoId ? spot[b.coingeckoId] : b.usdPrice;

        // Group by ticker. Keying on price was tried and is wrong: the same
        // token can be priced from different sources between refreshes, so a
        // holding split into a new row every time instead of merging.
        const key = b.symbol;

        const row = bySymbol.get(key) ?? {
            symbol: b.symbol,
            quantity: 0,
            usd: 0,
            weight: 0,
            priced: price !== undefined,
            coingeckoId: b.coingeckoId,
            icon: (b.coingeckoId ? images[b.coingeckoId] : undefined) ?? b.icon,
        };
        row.quantity += qty;
        if (price !== undefined) row.usd += qty * price;
        else row.priced = false;
        bySymbol.set(key, row);
    }

    const assets = Array.from(bySymbol.values()).sort((a, b) => b.usd - a.usd);
    const totalUsd = assets.reduce((acc, a) => acc + a.usd, 0);
    for (const a of assets) {
        a.weight = totalUsd > 0 ? (a.usd / totalUsd) * 100 : 0;
    }

    const walletRows: WalletRow[] = wallets
        .map((w) => {
            const mine = balances.filter((b) => b.walletId === w.id);
            const usd = mine.reduce((acc, b) => {
                const price = b.coingeckoId ? spot[b.coingeckoId] : b.usdPrice;
                if (price === undefined) return acc;
                return acc + toDecimal(b.amount, b.decimals) * price;
            }, 0);
            const chains = Array.from(
                new Set(mine.filter((b) => b.amount > 0n).map((b) => b.chainId)),
            );
            return { wallet: w, chains, usd };
        })
        .sort((a, b) => b.usd - a.usd);

    return { assets, wallets: walletRows, totalUsd };
}

/** Which chains a wallet kind can appear on. */
function chainsForWallets(wallets: Wallet[]): ChainConfig[] {
    const kinds = new Set(wallets.map((w) => w.kind));
    // HyperCore is addressed by a 0x address, so any EVM wallet can hold there.
    if (kinds.has('evm')) kinds.add('hypercore');
    return getSupportedChains().filter((c) => kinds.has(c.kind));
}

export async function loadPortfolio(
    settings: Settings,
): Promise<PortfolioResult> {
    const wallets = settings.wallets;
    const mode: 'alchemy' | 'public' = settings.alchemyKey ? 'alchemy' : 'public';
    const chainStatus: ChainStatus[] = [];
    const balances: RawBalance[] = [];
    const walletIssues: Record<string, string> = {};

    // Only touch chains a saved wallet could actually exist on.
    const targets = chainsForWallets(wallets);

    await Promise.all(
        targets.map(async (chain) => {
            // Keeta exposes no balance endpoint we support yet; it remains
            // fully available in Tax Export.
            if (chain.kind === 'keeta') {
                chainStatus.push({
                    chainId: chain.id,
                    state: 'unsupported',
                    message: 'Keeta balances are not supported yet — use Tax Export.',
                });
                return;
            }

            const urls = resolveRpcs(chain, settings);
            if (urls.length === 0) {
                chainStatus.push({
                    chainId: chain.id,
                    state: 'unreachable',
                    message: `No endpoint for ${chain.name}. Add an Alchemy key or a custom RPC in Settings.`,
                });
                return;
            }

            try {
                if (chain.kind === 'btc') {
                    const btc = await fetchBitcoinBalances(chain, wallets);
                    balances.push(...btc.balances);
                    chainStatus.push(
                        btc.failures > 0
                            ? {
                                  chainId: chain.id,
                                  state: 'degraded',
                                  message: `${btc.failures} address${btc.failures === 1 ? '' : 'es'} could not be read from the block explorers.`,
                              }
                            : { chainId: chain.id, state: 'ok' },
                    );
                    return;
                }

                if (chain.kind === 'hypercore') {
                    const hl = await fetchHyperCoreBalances(chain, wallets);
                    balances.push(...hl.balances);
                    chainStatus.push(
                        hl.perpsUnavailable
                            ? {
                                  chainId: chain.id,
                                  state: 'degraded',
                                  message:
                                      'Spot balances only — the perps account could not be read.',
                              }
                            : { chainId: chain.id, state: 'ok' },
                    );
                    return;
                }

                if (chain.kind === 'svm') {
                    const sol = await fetchSolanaBalances(chain, urls, wallets);
                    balances.push(...sol.balances);

                    const notes: string[] = [];
                    for (const bad of sol.invalid) {
                        walletIssues[bad.id] = bad.reason;
                    }
                    if (sol.invalid.length > 0) {
                        notes.push(
                            `Skipped ${sol.invalid.map((b) => b.name).join(', ')} — not a valid Solana address. Fix it in Settings.`,
                        );
                    }
                    // Report what the endpoints actually said. A guessed cause
                    // sends people to fix the wrong thing.
                    if (sol.balanceFailures > 0) {
                        notes.push(
                            `Balances failed: ${sol.balanceError || 'unknown error'}.`,
                        );
                    }
                    if (sol.tokensUnavailable) {
                        notes.push(
                            `Token lookup failed: ${sol.tokenError || 'unknown error'}.`,
                        );
                    }
                    if (!settings.alchemyKey) {
                        notes.push(
                            'Public Solana endpoints block token lookups — an Alchemy key is needed for SPL balances.',
                        );
                    }

                    chainStatus.push(
                        notes.length > 0
                            ? {
                                  chainId: chain.id,
                                  state: 'degraded',
                                  message: notes.join(' '),
                              }
                            : { chainId: chain.id, state: 'ok' },
                    );
                    return;
                } else {
                    const client = buildEvmClient(chain, settings);
                    if (!client) throw new Error('Could not build client');
                    balances.push(
                        ...(await fetchEvmBalances(client, chain, wallets)),
                    );
                }
                chainStatus.push({ chainId: chain.id, state: 'ok' });
            } catch (e) {
                chainStatus.push({
                    chainId: chain.id,
                    state: 'failed',
                    message: e instanceof Error ? e.message : 'Request failed',
                });
            }
        }),
    );

    // Price everything we can name.
    const ids = balances
        .map((b) => b.coingeckoId)
        .filter((x): x is string => !!x);
    let spot: Record<string, number> = {};
    let images: Record<string, string> = {};
    try {
        const market = await fetchMarketData(ids);
        spot = market.prices;
        images = market.images;
    } catch {
        // Unpriced assets still show quantities.
    }

    const { assets, wallets: walletRows, totalUsd } = aggregate(
        balances,
        spot,
        wallets,
        images,
    );

    return {
        balances,
        assets,
        wallets: walletRows,
        totalUsd,
        chainStatus,
        fetchedAt: Date.now(),
        mode,
        spot,
        images,
        walletIssues,
        incomplete: chainStatus.some((c) => c.state === 'failed'),
    };
}

export interface ChartPoint {
    t: number;
    usd: number;
}

/**
 * Value today's holdings at each of the last 365 days' prices.
 *
 * This is deliberately not true historical portfolio value — it ignores every
 * past buy, sell and transfer. It is what the current bag would have been
 * worth. Cheap, and honest as long as the UI says so.
 */
export interface ChartResult {
    points: ChartPoint[];
    /** Value held in assets with no price history, carried flat. */
    flatUsd: number;
    /** That value as a share of the charted total, 0-1. */
    flatShare: number;
}

export async function buildChart(
    assets: AssetRow[],
    /** Clamp the series to on/after this time, when first activity is known. */
    since?: number | null,
): Promise<ChartResult> {
    const held = assets.filter((a) => a.quantity > 0);
    const priced = held.filter((a) => a.coingeckoId);

    // Assets priced by a source other than CoinGecko (Solana mints via
    // Jupiter) have no historical series available. Dropping them silently
    // made the chart disagree with the header total by orders of magnitude,
    // so their present value is carried flat across the window instead. The
    // magnitude stays honest; only their past movement is unknown.
    const flatUsd = held
        .filter((a) => !a.coingeckoId && a.priced)
        .reduce((acc, a) => acc + a.usd, 0);

    const total = held.reduce((acc, a) => acc + a.usd, 0);
    const flatShare = total > 0 ? flatUsd / total : 0;

    if (priced.length === 0) {
        return { points: [], flatUsd, flatShare };
    }

    const histories = await fetchHistories(
        priced.map((a) => a.coingeckoId as string),
    );
    const daily = new Map<string, Map<string, number>>();
    for (const [id, series] of Object.entries(histories)) {
        daily.set(id, toDailyMap(series));
    }

    // A history request can fail or be rate limited. Such an asset used to
    // contribute nothing to every point while still counting in the header,
    // which is why the chart could sit well below the stated total. Carry it
    // flat at its current value instead, exactly like the ones CoinGecko
    // cannot name at all.
    const withHistory = priced.filter(
        (a) => (daily.get(a.coingeckoId as string)?.size ?? 0) > 0,
    );
    const missingHistoryUsd = priced
        .filter((a) => (daily.get(a.coingeckoId as string)?.size ?? 0) === 0)
        .reduce((acc, a) => acc + a.usd, 0);

    const carried = flatUsd + missingHistoryUsd;
    const carriedShare = total > 0 ? carried / total : 0;

    if (withHistory.length === 0) {
        return { points: [], flatUsd: carried, flatShare: carriedShare };
    }

    // Union of all days any asset has a price for.
    const days = new Set<string>();
    for (const a of withHistory) {
        const m = daily.get(a.coingeckoId as string);
        if (m) for (const d of m.keys()) days.add(d);
    }
    const sorted = Array.from(days).sort();

    const points = sorted.map((day) => {
        let usd = carried;
        for (const a of withHistory) {
            const price = daily.get(a.coingeckoId as string)?.get(day);
            // Missing single days would otherwise dip the line; hold the
            // asset's current value for that day instead of dropping it.
            usd += a.quantity * (price ?? 0) || 0;
            if (price === undefined) usd += a.usd;
        }
        return { t: Date.parse(`${day}T00:00:00Z`), usd };
    });

    if (typeof since !== 'number') {
        return { points, flatUsd: carried, flatShare: carriedShare };
    }

    // Drop days before the wallet existed. Keep at least two points so a very
    // new wallet still renders a line rather than collapsing to nothing.
    const clamped = points.filter((p) => p.t >= since);
    return {
        points: clamped.length >= 2 ? clamped : points.slice(-2),
        flatUsd: carried,
        flatShare: carriedShare,
    };
}

export const chainName = (id: string): string => CHAINS[id]?.name ?? id;

/**
 * Fold a single wallet's freshly read result into an existing portfolio.
 *
 * Refreshing one wallet must not disturb the others: their balances, prices
 * and chain statuses are kept as they were, and only the refreshed wallet's
 * rows are replaced.
 */
export function mergeWalletResult(
    current: PortfolioResult,
    walletId: string,
    fresh: PortfolioResult,
    wallets: Wallet[],
): PortfolioResult {
    const balances = [
        ...current.balances.filter((b) => b.walletId !== walletId),
        ...fresh.balances,
    ];
    const spot = { ...current.spot, ...fresh.spot };
    const images = { ...current.images, ...fresh.images };

    // Chain statuses from the scoped run only describe the chains it touched.
    const touched = new Set(fresh.chainStatus.map((c) => c.chainId));
    const chainStatus = [
        ...current.chainStatus.filter((c) => !touched.has(c.chainId)),
        ...fresh.chainStatus,
    ];

    const walletIssues = { ...current.walletIssues };
    delete walletIssues[walletId];
    Object.assign(walletIssues, fresh.walletIssues);

    const { assets, wallets: walletRows, totalUsd } = aggregate(
        balances,
        spot,
        wallets,
        images,
    );

    return {
        balances,
        assets,
        wallets: walletRows,
        totalUsd,
        chainStatus,
        fetchedAt: Date.now(),
        mode: fresh.mode,
        spot,
        images,
        walletIssues,
        incomplete: chainStatus.some((c) => c.state === 'failed'),
    };
}

/**
 * Refresh market prices against already-cached balances.
 *
 * This is intentionally cheaper than `loadPortfolio`: balances, NFT data and
 * chain status stay untouched while only spot prices/logos are updated.
 */
export async function repricePortfolio(
    current: PortfolioResult,
    wallets: Wallet[],
): Promise<PortfolioResult> {
    const ids = current.balances
        .map((b) => b.coingeckoId)
        .filter((x): x is string => !!x);
    const market = await fetchMarketData(ids);
    const spot = { ...current.spot, ...market.prices };
    const images = { ...current.images, ...market.images };
    const { assets, wallets: walletRows, totalUsd } = aggregate(
        current.balances,
        spot,
        wallets,
        images,
    );

    return {
        ...current,
        assets,
        wallets: walletRows,
        totalUsd,
        spot,
        images,
        fetchedAt: Date.now(),
    };
}

/* ------------------------------------------------------------------ *
 * Caching. Reopening the app should cost nothing; refresh is explicit.
 * ------------------------------------------------------------------ */

export function toCache(r: PortfolioResult): CachedPortfolio {
    return {
        fetchedAt: r.fetchedAt,
        mode: r.mode,
        // bigint has no JSON form, so amounts round-trip as decimal strings.
        balances: r.balances.map((b) => ({
            chainId: b.chainId,
            walletId: b.walletId,
            symbol: b.symbol,
            decimals: b.decimals,
            amount: b.amount.toString(),
            coingeckoId: b.coingeckoId,
            usdPrice: b.usdPrice,
            icon: b.icon,
        })),
        spot: r.spot,
        images: r.images,
        chainStatus: r.chainStatus,
        walletIssues: r.walletIssues,
    };
}

export function fromCache(
    c: CachedPortfolio,
    wallets: Wallet[],
): PortfolioResult | null {
    try {
        const balances: RawBalance[] = c.balances.map((b) => ({
            chainId: b.chainId,
            walletId: b.walletId,
            symbol: b.symbol,
            decimals: b.decimals,
            amount: BigInt(b.amount),
            coingeckoId: b.coingeckoId,
            usdPrice: b.usdPrice,
            icon: b.icon,
        }));
        const chainStatus = c.chainStatus as ChainStatus[];
        const { assets, wallets: walletRows, totalUsd } = aggregate(
            balances,
            c.spot,
            wallets,
            c.images,
        );
        return {
            balances,
            assets,
            wallets: walletRows,
            totalUsd,
            chainStatus,
            fetchedAt: c.fetchedAt,
            mode: c.mode,
            spot: c.spot,
            images: c.images,
            walletIssues: c.walletIssues ?? {},
            incomplete: chainStatus.some((x) => x.state === 'failed'),
        };
    } catch {
        // A malformed cache must never block a real load.
        return null;
    }
}
