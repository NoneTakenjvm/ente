import type { JSX } from "react";
import { Spinner } from "@/components/ui/spinner";

interface PageLoaderProps {
    message: string;
}

export function PageLoader({ message }: PageLoaderProps): JSX.Element {
    return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
            <Spinner className="size-6" />
            <p className="text-sm text-muted-foreground">{message}</p>
        </div>
    );
}
