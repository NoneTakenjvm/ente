"use client";

import Link from "next/link";
import { useRouter } from "next/router";
import {
    ChevronLeft,
    Lock,
    LogOut,
    MoreVertical,
    SlidersHorizontal,
    Images,
    Film,
} from "lucide-react";
import type { ReactNode, JSX } from "react";
import { useSessionStore } from "@/stores/session-store";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

interface AppShellProps {
    title: string;
    titleBadge?: ReactNode;
    email?: string;
    actions?: ReactNode;
    onBack?: () => void;
    children: ReactNode;
}

const navItems = [
    { href: "/gallery", label: "Media", icon: Film },
    { href: "/albums", label: "Albums", icon: Images },
    { href: "/manage", label: "Manage", icon: SlidersHorizontal },
] as const;

export function AppShell({
    title,
    titleBadge,
    email,
    actions,
    onBack,
    children,
}: AppShellProps): JSX.Element {
    const router = useRouter();
    const pathname = router.pathname;

    return (
        <div className="flex min-h-dvh flex-col bg-background">
            <header className="sticky top-0 z-40 border-b border-border bg-background/95 pt-[env(safe-area-inset-top)] backdrop-blur supports-backdrop-filter:bg-background/80">
                <div className="flex items-center gap-2 px-4 py-3">
                    {onBack ? (
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Go back"
                            onClick={onBack}
                        >
                            <ChevronLeft />
                        </Button>
                    ) : null}
                    <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                            <h1 className="truncate text-lg font-semibold tracking-tight">
                                {title}
                            </h1>
                            {titleBadge}
                        </div>
                        {email ? (
                            <p className="truncate text-xs text-muted-foreground">
                                {email}
                            </p>
                        ) : null}
                    </div>
                    {actions ? (
                        <div className="flex shrink-0 items-center gap-1">
                            {actions}
                        </div>
                    ) : null}
                    <AccountMenu />
                </div>
            </header>

            <main className="flex min-h-0 flex-1 flex-col pb-[calc(4rem+env(safe-area-inset-bottom))]">
                {children}
            </main>

            <nav
                className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80"
                aria-label="Main navigation"
            >
                <div className="grid grid-cols-3 gap-1 px-2 py-1.5">
                    {navItems.map(({ href, label, icon: Icon }) => {
                        const active = pathname === href;
                        return (
                            <Link
                                key={href}
                                href={href}
                                className={cn(
                                    "flex flex-col items-center gap-0.5 rounded-lg px-1 py-2 text-[0.65rem] font-medium transition-colors",
                                    active ?
                                        "bg-accent text-accent-foreground" :
                                        "text-muted-foreground hover:bg-muted hover:text-foreground",
                                )}
                                aria-current={active ? "page" : undefined}
                            >
                                <Icon className="size-5" aria-hidden />
                                <span>{label}</span>
                            </Link>
                        );
                    })}
                </div>
            </nav>
        </div>
    );
}

function AccountMenu(): JSX.Element {
    const router = useRouter();
    const lock = useSessionStore((s) => s.lock);
    const logout = useSessionStore((s) => s.logout);

    const handleLock = (): void => {
        lock();
        void router.replace("/login");
    };

    const handleLogout = (): void => {
        logout();
        void router.replace("/login");
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Account menu"
                    />
                }
            >
                <MoreVertical data-icon="inline-start" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuGroup>
                    <DropdownMenuItem onClick={handleLock}>
                        <Lock data-icon="inline-start" />
                        Lock
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        variant="destructive"
                        onClick={handleLogout}
                    >
                        <LogOut data-icon="inline-start" />
                        Sign out
                    </DropdownMenuItem>
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
