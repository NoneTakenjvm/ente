import type { JSX } from "react";
import { WifiOff } from "lucide-react";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from "@/components/ui/empty";

export default function OfflinePage(): JSX.Element {
    return (
        <main className="flex min-h-dvh items-center justify-center px-4 py-8">
            <Empty className="max-w-sm border-0">
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <WifiOff />
                    </EmptyMedia>
                    <EmptyTitle>You are offline</EmptyTitle>
                    <EmptyDescription>
                        Sign in while online to unlock your encrypted library.
                        Cached photos are viewable only during an active session
                        after login.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        </main>
    );
}
