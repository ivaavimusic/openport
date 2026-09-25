'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Navbar } from '@/components/Navbar';
import { ChainFilter } from '@/components/ChainFilter';
import { ChainBadgeRow } from '@/components/ChainBadgeRow';
import { ChainLogo } from '@/components/ChainLogo';
import { PortfolioChart } from '@/components/PortfolioChart';
import { getChainGroups, groupChainIds, CHAINS } from '@/lib/chains';
import {
    loadSettings,
    saveSettings,
    appendSnapshot,
    usedCategories,
    Settings,
    DEFAULT_PRICE_REFRESH_MS,
} from '@/lib/settings';
import { toDecimal } from '@/lib/evm';
import {
    loadPortfolio,
    buildChart,
    aggregate,
    toCache,
    fromCache,
    mergeWalletResult,
    repricePortfolio,
    PortfolioResult,
    ChartPoint,
} from '@/lib/portfolio';
import { Check, ChevronDown, ChevronRight, ChevronsDown, Layers, RefreshCw, TriangleAlert, Wallet as WalletIcon } from 'lucide-react';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getScopeFirstSeen } from '@/lib/firstseen';
import { TokenLogo } from '@/components/TokenLogo';
import { WalletAvatar } from '@/components/WalletAvatar';
import { NftGrid } from '@/components/NftGrid';
import { Footer } from '@/components/Footer';
import { loadNfts, clearNftCache, clearDerivedCaches, NftResult } from '@/lib/nfts';
import { toast } from 'sonner';

const money = (n: number) =>
    n.toLocaleString('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
    });

const qty = (n: number) =>
    n.toLocaleString('en-US', {
        maximumFractionDigits: n >= 1 ? 4 : 8,
    });

const shorten = (a: string) =>
    a.length <= 16 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`;

const ago = (t: number) => {
    const m = Math.floor((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
};

export default function PortfolioPage() {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [data, setData] = useState<PortfolioResult | null>(null);
    const [chart, setChart] = useState<ChartPoint[]>([]);
    /** Share of the charted total that has no price history, 0-1. */
    const [flatShare, setFlatShare] = useState(0);
    const [loading, setLoading] = useState(false);
    const [priceRefreshing, setPriceRefreshing] = useState(false);
    const [chartLoading, setChartLoading] = useState(false);
    const [selected, setSelected] = useState<string[]>([]);
    /** Empty = every wallet combined. */
    const [walletIds, setWalletIds] = useState<string[]>([]);
    /** null = every category. Mutually exclusive with walletId. */
    const [category, setCategory] = useState<string | null>(null);
    /** Earliest on-chain activity in the current scope, if determinable. */
    const [firstSeen, setFirstSeen] = useState<number | null>(null);
    /** True while showing restored figures that have not been re-fetched. */
    const [stale, setStale] = useState(false);
    const [assetTab, setAssetTab] = useState<'tokens' | 'nfts'>('tokens');
    const [nfts, setNfts] = useState<NftResult | null>(null);
    const [nftsLoading, setNftsLoading] = useState(false);
    /** Wallet currently being refreshed on its own. */
    const [refreshingWallet, setRefreshingWallet] = useState<string | null>(null);
    /** Wallet whose holdings are expanded beneath its row. */
    const [openWallet, setOpenWallet] = useState<string | null>(null);

    /**
     * One wallet's holdings, split by chain. Everything needed is already in
     * memory, so opening a wallet costs nothing.
     */
    const holdingsOf = useCallback(
        (walletId: string) => {
            if (!data) return [];
            return data.balances
                .filter((b) => b.walletId === walletId && b.amount > 0n)
                .map((b) => {
                    const quantity = toDecimal(b.amount, b.decimals);
                    const price = b.coingeckoId
                        ? data.spot[b.coingeckoId]
                        : b.usdPrice;
                    return {
                        key: `${b.chainId}-${b.symbol}`,
                        symbol: b.symbol,
                        chainId: b.chainId,
                        quantity,
                        usd: price !== undefined ? quantity * price : undefined,
                        icon:
                            (b.coingeckoId
                                ? data.images[b.coingeckoId]
                                : undefined) ?? b.icon,
                    };
                })
                .sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
        },
        [data],
    );

    // Re-read one wallet without disturbing the others.
    const refreshWallet = useCallback(
        async (walletId: string) => {
            if (!settings || !data) return;
            const wallet = settings.wallets.find((w) => w.id === walletId);
            if (!wallet) return;

            setRefreshingWallet(walletId);
            try {
                const fresh = await loadPortfolio({
                    ...settings,
                    wallets: [wallet],
                });
                const merged = mergeWalletResult(
                    data,
                    walletId,
                    fresh,
                    settings.wallets,
                );
                setData(merged);
                setStale(false);

                const next: Settings = { ...settings, cache: toCache(merged) };
                saveSettings(next);
                setSettings(next);

                for (const p of fresh.chainStatus) {
                    if (p.state === 'ok' || !p.message) continue;
                    toast.warning(CHAINS[p.chainId]?.name ?? p.chainId, {
                        description: p.message,
                    });
                }
            } catch (e) {
                toast.error(`Could not refresh ${wallet.name}`, {
                    description:
                        e instanceof Error ? e.message : 'Unknown error',
                });
            } finally {
                setRefreshingWallet(null);
            }
        },
        [settings, data],
    );

    useEffect(() => {
        setSettings(loadSettings());
    }, []);

    const refresh = useCallback(
        async (s: Settings, hard = false) => {
            if (s.wallets.length === 0) {
                setData(null);
                setChart([]);
                return;
            }
            setLoading(true);
            if (hard) {
                // Re-scan everything, including work already done: prices,
                // token metadata, NFTs and wallet ages all go.
                clearDerivedCaches();
            } else {
                // Balances are always read fresh; only NFTs would otherwise
                // stay stale behind their own cache.
                clearNftCache();
            }
            setNfts(null);
            try {
                const result = await loadPortfolio(s);
                setData(result);
                setStale(false);

                // One toast per unhappy chain keeps the page itself clean.
                for (const p of result.chainStatus) {
                    if (p.state === 'ok' || !p.message) continue;
                    const name = CHAINS[p.chainId]?.name ?? p.chainId;
                    if (p.state === 'failed' || p.state === 'unreachable') {
                        toast.error(name, { description: p.message });
                    } else {
                        toast.warning(name, { description: p.message });
                    }
                }
                if (result.incomplete) {
                    toast.warning('Total is incomplete', {
                        description:
                            'Some chains could not be read, so their balances are missing.',
                    });
                }

                // Persist the result so reopening the app costs no RPC calls,
                // and record a real snapshot of the true total.
                let next: Settings = { ...s, cache: toCache(result) };
                if (result.totalUsd > 0 && !result.incomplete) {
                    next = appendSnapshot(next, result.totalUsd);
                }
                saveSettings(next);
                setSettings(next);

                // The chart is rebuilt by the filter effect, which knows the
                // active wallet/chain scope.
            } catch (e) {
                toast.error('Could not load portfolio', {
                    description:
                        e instanceof Error ? e.message : 'Unknown error',
                });
            } finally {
                setLoading(false);
            }
        },
        [],
    );

    const refreshPrices = useCallback(async (current: PortfolioResult, s: Settings) => {
        if (current.balances.length === 0) return;
        setPriceRefreshing(true);
        try {
            const repriced = await repricePortfolio(current, s.wallets);
            setData(repriced);
            setStale(false);

            const next: Settings = { ...s, cache: toCache(repriced) };
            saveSettings(next);
            setSettings(next);
        } catch (e) {
            toast.error('Could not refresh prices', {
                description: e instanceof Error ? e.message : 'Unknown error',
            });
        } finally {
            setPriceRefreshing(false);
        }
    }, []);

    // Show the cached portfolio instantly and make no network calls; only fetch
    // balances when there is nothing cached. Prices refresh themselves on the
    // user's configured cadence.
    useEffect(() => {
        if (!settings || data || settings.wallets.length === 0) return;
        if (settings.cache) {
            const restored = fromCache(settings.cache, settings.wallets);
            if (restored) {
                setData(restored);
                setStale(true);
                return;
            }
        }
        void refresh(settings);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings?.wallets.length, settings?.cache?.fetchedAt]);

    useEffect(() => {
        if (!settings || !data || loading || priceRefreshing) return;
        const every = settings.priceRefreshMs ?? DEFAULT_PRICE_REFRESH_MS;
        const wait = data.fetchedAt + every - Date.now();

        if (wait <= 0) {
            void refreshPrices(data, settings);
            return;
        }

        const timeout = window.setTimeout(
            () => void refreshPrices(data, settings),
            wait,
        );
        return () => window.clearTimeout(timeout);
    }, [
        data,
        loading,
        priceRefreshing,
        refreshPrices,
        settings,
        settings?.priceRefreshMs,
    ]);

    // A badge can stand for several sources (Hyperliquid is two), so toggling
    // it moves every id behind it together.
    const toggleChain = (ids: string[]) =>
        setSelected((prev) => {
            const on = ids.some((id) => prev.includes(id));
            return on
                ? prev.filter((x) => !ids.includes(x))
                : [...prev, ...ids];
        });

    // Re-aggregate locally when a chain or wallet filter is active — no refetch.
    const view = useMemo(() => {
        if (!data || !settings) return null;
        const noChainFilter = selected.length === 0;
        const inScope = new Set(
            settings.wallets
                .filter(
                    (w) =>
                        (walletIds.length === 0 || walletIds.includes(w.id)) &&
                        (category === null || w.category === category),
                )
                .map((w) => w.id),
        );
        const noWalletFilter = walletIds.length === 0 && category === null;
        if (noChainFilter && noWalletFilter) {
            return {
                assets: data.assets,
                wallets: data.wallets,
                totalUsd: data.totalUsd,
            };
        }
        const filtered = data.balances.filter(
            (b) =>
                (noChainFilter || selected.includes(b.chainId)) &&
                (noWalletFilter || inScope.has(b.walletId)),
        );
        const scope = settings.wallets.filter((w) => inScope.has(w.id));
        return aggregate(filtered, data.spot, scope, data.images);
    }, [data, settings, selected, walletIds, category]);

    const activeWallet =
        walletIds.length === 1
            ? (settings?.wallets.find((w) => w.id === walletIds[0]) ?? null)
            : null;
    const scopeLabel = activeWallet
        ? activeWallet.name
        : walletIds.length > 1
          ? `${walletIds.length} wallets`
          : (category ?? 'All wallets');

    // A wallet chart needs that wallet's own holdings, not the whole portfolio,
    // and must not draw a line from before those wallets existed.
    useEffect(() => {
        if (!view || !settings || !data) return;
        let cancelled = false;
        setChartLoading(true);

        const scopeWallets = settings.wallets.filter(
            (w) =>
                (walletIds.length === 0 || walletIds.includes(w.id)) &&
                (category === null || w.category === category),
        );
        const chainsByWallet = Object.fromEntries(
            data.wallets.map((w) => [w.wallet.id, w.chains]),
        );

        getScopeFirstSeen(scopeWallets, chainsByWallet, settings)
            .catch(() => null)
            .then((since) => {
                if (cancelled) return null;
                setFirstSeen(since);
                return buildChart(view.assets, since);
            })
            .then((res) => {
                if (cancelled || !res) return;
                setChart(res.points);
                setFlatShare(res.flatShare);
            })
            .catch(() => !cancelled && setChart([]))
            .finally(() => !cancelled && setChartLoading(false));

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [walletIds.join(','), category, selected.join(','), data?.fetchedAt]);

    // NFTs are fetched only when the tab is actually opened, so the default
    // view never pays for them.
    useEffect(() => {
        if (assetTab !== 'nfts' || nfts || nftsLoading || !settings) return;
        setNftsLoading(true);
        loadNfts(settings)
            .then(setNfts)
            .catch(() =>
                setNfts({
                    items: [],
                    problems: [],
                    needsKey: !settings.alchemyKey,
                    truncated: false,
                }),
            )
            .finally(() => setNftsLoading(false));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [assetTab, settings?.alchemyKey]);

    const chainGroups = getChainGroups();
    const categories = usedCategories(settings?.wallets ?? []);
    const categoryTotals = useMemo(() => {
        const byId = new Map(
            (data?.wallets ?? []).map((w) => [w.wallet.id, w.usd]),
        );
        const totals: Record<string, number> = {};
        for (const w of settings?.wallets ?? []) {
            if (!w.category) continue;
            totals[w.category] = (totals[w.category] ?? 0) + (byId.get(w.id) ?? 0);
        }
        return totals;
    }, [data, settings]);
    const hasWallets = (settings?.wallets.length ?? 0) > 0;

    return (
        <div className="min-h-screen flex flex-col font-sans">
            <Navbar />

            <main className="flex-1 max-w-7xl w-full mx-auto px-6 py-8 flex flex-col gap-6">
                {!hasWallets ? (
                    <Card className="p-12 text-center border-dashed bg-card border-border/20 mt-8">
                        <div className="flex flex-col items-center gap-4 text-muted-foreground">
                            <WalletIcon className="w-12 h-12 opacity-20" />
                            <h2 className="text-lg font-medium text-foreground">
                                No wallets yet
                            </h2>
                            <p className="text-sm max-w-md">
                                Add an Ethereum, Base, Robinhood Chain or Solana address
                                and give it a name. Everything is stored in your browser.
                            </p>
                            <Link href="/settings">
                                <Button className="mt-2">Add a wallet</Button>
                            </Link>
                        </div>
                    </Card>
                ) : (
                    <>
                        {/* Header: total + refresh */}
                        <div className="flex items-end justify-between flex-wrap gap-4">
                            <div>
                                <div className="text-sm text-muted-foreground font-medium">
                                    {walletIds.length > 0 || category
                                        ? scopeLabel
                                        : 'Total value'}
                                    {selected.length > 0 && ' · filtered'}
                                </div>
                                <div className="text-4xl font-bold tracking-tight mt-1">
                                    {loading && !view
                                        ? '—'
                                        : money(view?.totalUsd ?? 0)}
                                </div>
                                <div className="text-xs text-muted-foreground mt-1">
                                    {data ? (
                                        <>
                                            {stale ? 'cached · ' : ''}
                                            updated {ago(data.fetchedAt)} ·{' '}
                                            {priceRefreshing
                                                ? 'refreshing prices · '
                                                : ''}
                                            {data.mode === 'alchemy'
                                                ? 'Alchemy key — full token discovery'
                                                : 'public RPC — major tokens only'}
                                        </>
                                    ) : (
                                        'not loaded'
                                    )}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="outline"
                                            className="gap-2 cursor-pointer max-w-[220px]"
                                        >
                                            {activeWallet ? (
                                                <WalletAvatar
                                                    address={activeWallet.address}
                                                    size={18}
                                                />
                                            ) : (
                                                <WalletIcon className="w-4 h-4" />
                                            )}
                                            <span className="truncate">
                                                {scopeLabel}
                                            </span>
                                            <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent
                                        align="end"
                                        className="w-72 bg-card border-border/50 max-h-[60vh] overflow-y-auto"
                                    >
                                        <DropdownMenuItem
                                            onClick={() => {
                                                setWalletIds([]);
                                                setCategory(null);
                                            }}
                                            className={`gap-3 py-2 cursor-pointer ${
                                                walletIds.length === 0 &&
                                                category === null
                                                    ? 'bg-accent'
                                                    : ''
                                            }`}
                                        >
                                            <WalletIcon className="w-4 h-4" />
                                            <span className="font-medium flex-1">
                                                All wallets
                                            </span>
                                            <span className="text-xs text-muted-foreground">
                                                {money(data?.totalUsd ?? 0)}
                                            </span>
                                        </DropdownMenuItem>

                                        {categories.length > 0 && (
                                            <>
                                                <DropdownMenuSeparator />
                                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    Categories
                                                </DropdownMenuLabel>
                                                {categories.map((c) => (
                                                    <DropdownMenuItem
                                                        key={c}
                                                        onClick={() => {
                                                            setWalletIds([]);
                                                            setCategory(c);
                                                        }}
                                                        className={`gap-3 py-2 cursor-pointer ${
                                                            category === c
                                                                ? 'bg-accent'
                                                                : ''
                                                        }`}
                                                    >
                                                        <Layers className="w-4 h-4" />
                                                        <span className="flex-1">{c}</span>
                                                        <span className="text-xs text-muted-foreground">
                                                            {money(categoryTotals[c] ?? 0)}
                                                        </span>
                                                    </DropdownMenuItem>
                                                ))}
                                                <DropdownMenuSeparator />
                                                <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                                                    Wallets
                                                </DropdownMenuLabel>
                                            </>
                                        )}
                                        {(data?.wallets ?? []).map((w) => (
                                            <DropdownMenuItem
                                                key={w.wallet.id}
                                                onSelect={(e) => {
                                                    // Keep the menu open so
                                                    // several can be picked.
                                                    e.preventDefault();
                                                    setCategory(null);
                                                    setWalletIds((prev) =>
                                                        prev.includes(w.wallet.id)
                                                            ? prev.filter(
                                                                  (x) =>
                                                                      x !==
                                                                      w.wallet.id,
                                                              )
                                                            : [...prev, w.wallet.id],
                                                    );
                                                }}
                                                className={`gap-2.5 py-1.5 cursor-pointer ${
                                                    walletIds.includes(w.wallet.id)
                                                        ? 'bg-accent'
                                                        : ''
                                                }`}
                                            >
                                                <Check
                                                    className={`w-3.5 h-3.5 shrink-0 ${
                                                        walletIds.includes(w.wallet.id)
                                                            ? 'opacity-100'
                                                            : 'opacity-0'
                                                    }`}
                                                />
                                                <WalletAvatar
                                                    address={w.wallet.address}
                                                    size={18}
                                                />
                                                <span className="flex-1 min-w-0 truncate text-xs font-medium">
                                                    {w.wallet.name}
                                                </span>
                                                <span className="text-[11px] text-muted-foreground tabular-nums shrink-0">
                                                    {money(w.usd)}
                                                </span>
                                            </DropdownMenuItem>
                                        ))}
                                    </DropdownMenuContent>
                                </DropdownMenu>

                                {/* Split button: refresh, or re-scan everything. */}
                                <div className="flex items-center">
                                    <Button
                                        onClick={() => settings && refresh(settings)}
                                        disabled={loading}
                                        variant="outline"
                                        className="gap-2 cursor-pointer rounded-r-none border-r-0"
                                    >
                                        <RefreshCw
                                            className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`}
                                        />
                                        {loading ? 'Refreshing…' : 'Refresh'}
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <Button
                                                variant="outline"
                                                size="icon"
                                                disabled={loading}
                                                aria-label="More refresh options"
                                                className="cursor-pointer rounded-l-none"
                                            >
                                                <ChevronDown className="w-4 h-4" />
                                            </Button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent
                                            align="end"
                                            className="w-72 bg-card border-border/50"
                                        >
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    settings && refresh(settings)
                                                }
                                                className="flex-col items-start gap-0.5 py-2 cursor-pointer"
                                            >
                                                <span className="font-medium">
                                                    Refresh
                                                </span>
                                                <span className="text-[11px] text-muted-foreground">
                                                    Re-read balances. Keeps prices,
                                                    token names and NFT results
                                                    already fetched.
                                                </span>
                                            </DropdownMenuItem>
                                            <DropdownMenuSeparator />
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    settings && refresh(settings, true)
                                                }
                                                className="flex-col items-start gap-0.5 py-2 cursor-pointer"
                                            >
                                                <span className="font-medium flex items-center gap-1.5">
                                                    <ChevronsDown className="w-3.5 h-3.5" />
                                                    Hard refresh
                                                </span>
                                                <span className="text-[11px] text-muted-foreground">
                                                    Clear every cache and scan from
                                                    scratch. Slower and uses more
                                                    requests.
                                                </span>
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                </div>
                            </div>
                        </div>

                        <ChainFilter
                            groups={chainGroups}
                            selected={selected}
                            onToggle={toggleChain}
                            onClear={() => setSelected([])}
                            status={data?.chainStatus}
                        />

                        <PortfolioChart
                            points={chart}
                            snapshots={settings?.snapshots}
                            loading={chartLoading}
                            firstSeen={firstSeen}
                            flatShare={flatShare}
                            canDetectFirstSeen={
                                data?.mode === 'alchemy' ||
                                activeWallet?.kind === 'svm'
                            }
                        />

                        {/* Assets */}
                        <Card className="border-0 bg-card text-card-foreground overflow-hidden">
                            <div className="px-6 pt-5 pb-3 flex items-center justify-between gap-4">
                                <h2 className="font-bold">Assets</h2>
                                <div className="flex items-center gap-1 rounded-lg bg-muted/50 p-0.5">
                                    {(['tokens', 'nfts'] as const).map((t) => (
                                        <button
                                            key={t}
                                            onClick={() => setAssetTab(t)}
                                            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                                                assetTab === t
                                                    ? 'bg-card text-foreground shadow-sm'
                                                    : 'text-muted-foreground hover:text-foreground'
                                            }`}
                                        >
                                            {t === 'tokens' ? 'Tokens' : 'NFTs'}
                                            {t === 'nfts' && nfts?.items.length
                                                ? ` (${nfts.items.length})`
                                                : ''}
                                        </button>
                                    ))}
                                </div>
                            </div>
                            {assetTab === 'nfts' ? (
                                <NftGrid
                                    result={nfts}
                                    loading={nftsLoading}
                                    selectedChains={selected}
                                    walletIds={walletIds}
                                />
                            ) : (
                            <div className="px-4 pb-2 overflow-x-auto overflow-y-auto max-h-[460px]">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 z-10 bg-card">
                                        <tr className="border-b border-border/10 text-muted-foreground bg-card">
                                            <th className="h-10 px-2 text-left font-medium">
                                                Asset
                                            </th>
                                            <th className="h-10 px-2 text-right font-medium">
                                                Quantity
                                            </th>
                                            <th className="h-10 px-2 text-right font-medium">
                                                Value
                                            </th>
                                            <th className="h-10 px-2 text-right font-medium">
                                                Weight
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(view?.assets ?? []).map((a) => (
                                            <tr
                                                key={a.symbol}
                                                className="border-b border-border/10 hover:bg-muted/10 transition-colors"
                                            >
                                                <td className="p-2 font-medium">
                                                    <div className="flex items-center gap-2">
                                                        <TokenLogo
                                                            symbol={a.symbol}
                                                            src={a.icon}
                                                            size={22}
                                                        />
                                                        {a.symbol}
                                                    </div>
                                                </td>
                                                <td className="p-2 text-right font-mono">
                                                    {qty(a.quantity)}
                                                </td>
                                                <td className="p-2 text-right font-medium">
                                                    {a.priced ? (
                                                        money(a.usd)
                                                    ) : (
                                                        <span className="text-muted-foreground text-xs">
                                                            price unavailable
                                                        </span>
                                                    )}
                                                </td>
                                                <td className="p-2 text-right text-muted-foreground">
                                                    {a.priced
                                                        ? `${a.weight.toFixed(1)}%`
                                                        : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                        {(view?.assets.length ?? 0) === 0 && !loading && (
                                            <tr>
                                                <td
                                                    colSpan={4}
                                                    className="p-6 text-center text-muted-foreground"
                                                >
                                                    No balances found.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                            )}
                        </Card>

                        {/* Wallets */}
                        <Card className="border-0 bg-card text-card-foreground overflow-hidden">
                            <div className="px-6 pt-5 pb-3 flex items-center justify-between">
                                <h2 className="font-bold">Wallets</h2>
                                <Link
                                    href="/settings"
                                    className="text-xs text-primary hover:underline"
                                >
                                    Manage
                                </Link>
                            </div>
                            <div className="px-4 pb-2 overflow-x-auto overflow-y-auto max-h-[460px]">
                                <table className="w-full text-sm">
                                    <thead className="sticky top-0 z-10 bg-card">
                                        <tr className="border-b border-border/10 text-muted-foreground bg-card">
                                            <th className="h-10 px-2 text-left font-medium">
                                                Name
                                            </th>
                                            <th className="h-10 px-2 text-left font-medium">
                                                Address
                                            </th>
                                            <th className="h-10 px-2 text-left font-medium">
                                                Chains
                                            </th>
                                            <th className="h-10 px-2 text-right font-medium">
                                                Value
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {(view?.wallets ?? []).map((w) => (
                                            <Fragment key={w.wallet.id}>
                                            <tr
                                                onClick={() =>
                                                    setOpenWallet((prev) =>
                                                        prev === w.wallet.id
                                                            ? null
                                                            : w.wallet.id,
                                                    )
                                                }
                                                aria-expanded={
                                                    openWallet === w.wallet.id
                                                }
                                                className="border-b border-border/10 hover:bg-muted/10 transition-colors cursor-pointer"
                                            >
                                                <td className="p-2 font-medium">
                                                    <div className="flex items-center gap-2">
                                                        <ChevronRight
                                                            className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${
                                                                openWallet ===
                                                                w.wallet.id
                                                                    ? 'rotate-90'
                                                                    : ''
                                                            }`}
                                                        />
                                                        <WalletAvatar
                                                            address={w.wallet.address}
                                                            size={24}
                                                        />
                                                        {w.wallet.name}
                                                        {data?.walletIssues[
                                                            w.wallet.id
                                                        ] && (
                                                            <span
                                                                title={
                                                                    data
                                                                        .walletIssues[
                                                                        w.wallet.id
                                                                    ]
                                                                }
                                                                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-red-500/10 text-red-600 dark:text-red-400"
                                                            >
                                                                <TriangleAlert className="w-3 h-3" />
                                                                Error
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="p-2 font-mono text-muted-foreground">
                                                    {shorten(w.wallet.address)}
                                                </td>
                                                <td className="p-2">
                                                    <ChainBadgeRow
                                                        groups={groupChainIds(
                                                            w.chains,
                                                        )}
                                                    />
                                                </td>
                                                <td className="p-2 text-right font-medium">
                                                    <div className="flex items-center justify-end gap-2">
                                                        {money(w.usd)}
                                                        <button
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                refreshWallet(
                                                                    w.wallet.id,
                                                                );
                                                            }}
                                                            disabled={
                                                                refreshingWallet !==
                                                                null
                                                            }
                                                            aria-label={`Refresh ${w.wallet.name}`}
                                                            title={`Refresh ${w.wallet.name}`}
                                                            className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors cursor-pointer"
                                                        >
                                                            <RefreshCw
                                                                className={`w-3.5 h-3.5 ${
                                                                    refreshingWallet ===
                                                                    w.wallet.id
                                                                        ? 'animate-spin'
                                                                        : ''
                                                                }`}
                                                            />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>

                                            {openWallet === w.wallet.id && (
                                                <tr className="border-b border-border/10">
                                                    <td colSpan={4} className="p-0">
                                                        <div className="bg-muted/20 px-4 py-3">
                                                            {holdingsOf(w.wallet.id)
                                                                .length === 0 ? (
                                                                <p className="text-xs text-muted-foreground py-2">
                                                                    Nothing held in this
                                                                    wallet.
                                                                </p>
                                                            ) : (
                                                                <table className="w-full text-xs">
                                                                    <thead>
                                                                        <tr className="text-muted-foreground">
                                                                            <th className="h-7 px-2 text-left font-medium">
                                                                                Asset
                                                                            </th>
                                                                            <th className="h-7 px-2 text-left font-medium">
                                                                                Chain
                                                                            </th>
                                                                            <th className="h-7 px-2 text-right font-medium">
                                                                                Quantity
                                                                            </th>
                                                                            <th className="h-7 px-2 text-right font-medium">
                                                                                Value
                                                                            </th>
                                                                        </tr>
                                                                    </thead>
                                                                    <tbody>
                                                                        {holdingsOf(
                                                                            w.wallet.id,
                                                                        ).map((h) => (
                                                                            <tr
                                                                                key={h.key}
                                                                                className="border-t border-border/10"
                                                                            >
                                                                                <td className="p-2">
                                                                                    <div className="flex items-center gap-2 font-medium">
                                                                                        <TokenLogo
                                                                                            symbol={h.symbol}
                                                                                            src={h.icon}
                                                                                            size={18}
                                                                                        />
                                                                                        {h.symbol}
                                                                                    </div>
                                                                                </td>
                                                                                <td className="p-2">
                                                                                    {CHAINS[h.chainId] && (
                                                                                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                                                                                            <ChainLogo
                                                                                                chain={CHAINS[h.chainId]}
                                                                                                size={14}
                                                                                            />
                                                                                            {CHAINS[h.chainId].name}
                                                                                        </span>
                                                                                    )}
                                                                                </td>
                                                                                <td className="p-2 text-right font-mono">
                                                                                    {qty(h.quantity)}
                                                                                </td>
                                                                                <td className="p-2 text-right font-medium">
                                                                                    {h.usd !== undefined ? (
                                                                                        money(h.usd)
                                                                                    ) : (
                                                                                        <span className="text-muted-foreground">
                                                                                            price unavailable
                                                                                        </span>
                                                                                    )}
                                                                                </td>
                                                                            </tr>
                                                                        ))}
                                                                    </tbody>
                                                                </table>
                                                            )}
                                                        </div>
                                                    </td>
                                                </tr>
                                            )}
                                            </Fragment>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        </Card>
                    </>
                )}

                <div className="flex-1" />
                <Footer />
            </main>
        </div>
    );
}
