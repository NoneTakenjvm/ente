import type { ComponentProps, JSX, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

interface MediaListCardProps extends Omit<ComponentProps<typeof Card>, "children"> {
    /** Content before the name: cover thumbnail, reorder handle, etc. */
    leading: ReactNode;
    name: string;
    badge: number;
    /** Line under the name row. */
    subtitle?: ReactNode;
    /** Content after the name, e.g. an edit button. */
    trailing?: ReactNode;
}

/** Row card shared by the album and recent-session lists. */
export function MediaListCard({
    leading,
    name,
    badge,
    subtitle,
    trailing,
    ...cardProps
}: MediaListCardProps): JSX.Element {
    return (
        <Card {...cardProps}>
            <div className="flex items-center gap-3 px-4 py-3">
                {leading}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1 text-base font-medium leading-snug break-words">
                            {name}
                        </span>
                        <Badge
                            variant="secondary"
                            className="mt-0.5 shrink-0 tabular-nums"
                        >
                            {badge}
                        </Badge>
                    </div>
                    {subtitle}
                </div>
                {trailing}
            </div>
        </Card>
    );
}
