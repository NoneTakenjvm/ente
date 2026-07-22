import { useCallback, useEffect, useState, type JSX } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { getEnteCore } from "@/core";
import {
    formatStorageBytes,
    getUserDetails,
    hasExceededStorageQuota,
    isPartOfFamily,
    planUsageBytes,
    totalAllowanceBytes,
    type UserDetails,
} from "@/core/api/user-details";

/**
 * Show Ente cloud storage usage vs plan allowance.
 */
export function ManageUsagePanel(): JSX.Element {
    const [details, setDetails] = useState<UserDetails | undefined>();
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | undefined>();

    const load = useCallback(async (): Promise<void> => {
        setLoading(true);
        setError(undefined);
        try {
            const next = await getUserDetails(getEnteCore().getHttpClient());
            setDetails(next);
        } catch (loadError: unknown) {
            setError(
                loadError instanceof Error ?
                    loadError.message :
                    "Could not load storage usage",
            );
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    if (loading && !details) {
        return (
            <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading usage…
            </div>
        );
    }

    const used = details ? planUsageBytes(details) : 0;
    const allowance = details ? totalAllowanceBytes(details) : 0;
    const percent =
        allowance > 0 ? Math.min(100, Math.round((used / allowance) * 100)) : 0;
    const overQuota = details ? hasExceededStorageQuota(details) : false;
    const planLabel =
        details?.subscription.productID === "free" ?
            "Free" :
            details?.subscription.productID ?? "Plan";

    return (
        <div className="flex flex-col gap-4 px-4 py-4">
            {error ? (
                <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            ) : null}

            <Card>
                <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
                    <div className="space-y-1.5">
                        <CardTitle>Cloud storage</CardTitle>
                        <CardDescription>
                            Usage against your Ente plan
                            {details && isPartOfFamily(details) ?
                                " (family pool)" :
                                ""}
                            .
                        </CardDescription>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        disabled={loading}
                        onClick={() => void load()}
                        aria-label="Refresh usage"
                    >
                        {loading ? <Spinner /> : <RefreshCw />}
                    </Button>
                </CardHeader>
                <CardContent className="space-y-4">
                    {details ? (
                        <>
                            <div className="space-y-2">
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-2xl font-semibold tabular-nums">
                                        {formatStorageBytes(used)}
                                    </span>
                                    <span className="text-sm text-muted-foreground tabular-nums">
                                        of {formatStorageBytes(allowance)}
                                    </span>
                                </div>
                                <Progress
                                    value={percent}
                                    className={
                                        overQuota ? "[&>div]:bg-destructive" : undefined
                                    }
                                />
                                <p className="text-xs text-muted-foreground">
                                    {percent}% used
                                    {overQuota ? " · over quota" : ""}
                                </p>
                            </div>
                            <dl className="grid gap-2 text-sm">
                                <div className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">Plan</dt>
                                    <dd className="truncate text-right font-medium">
                                        {planLabel}
                                        {details.subscription.period ?
                                            ` · ${details.subscription.period}` :
                                            ""}
                                    </dd>
                                </div>
                                {details.storageBonus > 0 ? (
                                    <div className="flex justify-between gap-3">
                                        <dt className="text-muted-foreground">
                                            Bonus
                                        </dt>
                                        <dd className="tabular-nums font-medium">
                                            {formatStorageBytes(
                                                details.storageBonus,
                                            )}
                                        </dd>
                                    </div>
                                ) : null}
                                <div className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">
                                        Files
                                    </dt>
                                    <dd className="tabular-nums font-medium">
                                        {details.fileCount.toLocaleString()}
                                    </dd>
                                </div>
                                <div className="flex justify-between gap-3">
                                    <dt className="text-muted-foreground">
                                        Your usage
                                    </dt>
                                    <dd className="tabular-nums font-medium">
                                        {formatStorageBytes(details.usage)}
                                    </dd>
                                </div>
                            </dl>
                            <p className="text-xs text-muted-foreground">
                                Items in trash still count toward storage until
                                permanently deleted.
                            </p>
                        </>
                    ) : null}
                </CardContent>
            </Card>
        </div>
    );
}
