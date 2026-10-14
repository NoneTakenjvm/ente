import type { JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ToolFooterProps {
    icon?: ReactNode;
    title: string;
    /** Buttons shown at the right of the title row. */
    actions: ReactNode;
    className?: string;
    /** Extra rows below the title row. */
    children?: ReactNode;
}

/**
 * Fixed bottom bar shared by the selection and tool footers: a title row with
 * an actions slot, then optional rows underneath.
 */
export function ToolFooter({
    icon,
    title,
    actions,
    className,
    children,
}: ToolFooterProps): JSX.Element {
    return (
        <footer
            className={cn(
                "fixed inset-x-0 bottom-0 z-30 flex flex-col gap-2 border-t border-border bg-background/95 px-3 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] backdrop-blur",
                className,
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <p className="flex min-w-0 items-center gap-1.5 truncate text-sm text-muted-foreground">
                    {icon}
                    <span className="truncate">{title}</span>
                </p>
                <div className="flex shrink-0 items-center gap-1.5">
                    {actions}
                </div>
            </div>
            {children}
        </footer>
    );
}
