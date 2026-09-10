import {
    useCallback,
    useEffect,
    useMemo,
    useState,
    type JSX,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/router";
import { Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { PageLoader } from "@/components/PageLoader";
import { SessionListCard } from "@/components/recents/SessionListCard";
import { SessionViewThumb } from "@/components/recents/SessionViewThumb";
import { SyncBanner } from "@/components/SyncBanner";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyTitle,
} from "@/components/ui/empty";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import {
    formatSessionLore,
    formatSessionName,
    type ViewSession,
} from "@/lib/view-sessions";
import type { EnteFile } from "ente-media/file";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
    useSessionStore,
} from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { useViewSessionsStore } from "@/stores/view-sessions-store";

const PhotoViewer = dynamic(
    () =>
        import("@/components/PhotoViewer").then((mod) => mod.PhotoViewer),
    { ssr: false },
);

type RecentsMode = "list" | "view";

export default function RecentsPage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);
    const sessions = useViewSessionsStore((s) => s.sessions);
    const deleteSession = useViewSessionsStore((s) => s.deleteSession);
    const allFiles = useLibraryStore((s) => s.allFiles);
    const syncStatus = useLibraryStore((s) => s.syncStatus);
    const getFileById = useLibraryStore((s) => s.getFileById);
    const initialLoadDone = useLibraryBootstrap();

    const [mode, setMode] = useState<RecentsMode>("list");
    const [activeSessionId, setActiveSessionId] = useState<string | undefined>();
    const [viewerIndex, setViewerIndex] = useState<number | undefined>();
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

    const filesById = useMemo((): Map<number, EnteFile> => {
        const map = new Map<number, EnteFile>();
        for (const file of allFiles) {
            map.set(file.id, file);
        }
        return map;
    }, [allFiles]);

    const activeSession = useMemo(
        (): ViewSession | undefined =>
            sessions.find((session) => session.id === activeSessionId),
        [activeSessionId, sessions],
    );

    const sessionTiles = useMemo(() => {
        if (!activeSession) {
            return [];
        }
        let carouselIndex = 0;
        return activeSession.views.map((view, index) => {
            const file = filesById.get(view.fileId) ?? getFileById(view.fileId);
            if (!file) {
                return {
                    key: `${activeSession.id}-${index}`,
                    index,
                    file: undefined as EnteFile | undefined,
                    carouselIndex: undefined as number | undefined,
                };
            }
            const slot = carouselIndex;
            carouselIndex += 1;
            return {
                key: `${activeSession.id}-${index}-${file.id}`,
                index,
                file,
                carouselIndex: slot,
            };
        });
    }, [activeSession, filesById, getFileById]);

    const carouselFiles = useMemo(
        (): EnteFile[] =>
            sessionTiles
                .filter((tile) => tile.file !== undefined)
                .map((tile) => tile.file as EnteFile),
        [sessionTiles],
    );

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
        }
    }, [router]);

    const handleOpenSession = (sessionId: string): void => {
        setActiveSessionId(sessionId);
        setMode("view");
        setViewerIndex(undefined);
        setShowDeleteConfirm(false);
    };

    const handleBack = (): void => {
        setMode("list");
        setActiveSessionId(undefined);
        setViewerIndex(undefined);
        setShowDeleteConfirm(false);
    };

    const handleOpenTile = useCallback((carouselIndex: number): void => {
        setViewerIndex(carouselIndex);
    }, []);

    const handleCloseViewer = useCallback((): void => {
        setViewerIndex(undefined);
    }, []);

    const handleConfirmDelete = (): void => {
        if (!activeSessionId) {
            return;
        }
        deleteSession(activeSessionId);
        setShowDeleteConfirm(false);
        setViewerIndex(undefined);
        setActiveSessionId(undefined);
        setMode("list");
    };

    const showFullPageLoader =
        !initialLoadDone &&
        (syncStatus === "loadingFromCache" || syncStatus === "syncing") &&
        allFiles.length === 0;

    if (!isSessionAuthenticated()) {
        return <PageLoader message="Redirecting to sign in…" />;
    }

    const title =
        mode === "list" ?
            "Recents" :
            activeSession ?
                formatSessionName(activeSession.startedAt) :
                "Session";

    return (
        <AppShell
            title={title}
            email={email}
            onBack={mode === "list" ? undefined : handleBack}
            actions={
                mode === "view" && activeSession ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Delete session"
                        onClick={() => setShowDeleteConfirm(true)}
                    >
                        <Trash2 />
                    </Button>
                ) : undefined
            }
        >
            <SyncBanner />
            {showFullPageLoader ? (
                <PageLoader message="Loading library…" />
            ) : mode === "list" ? (
                sessions.length === 0 ? (
                    <Empty className="py-16">
                        <EmptyHeader>
                            <EmptyTitle>No recent sessions</EmptyTitle>
                            <EmptyDescription>
                                Open photos in full view for more than a second
                                and they will show up here.
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <div className="flex flex-col gap-3 px-4 py-4">
                        {sessions.map((session) => {
                            const cover =
                                session.lastViewedFileId ?
                                    filesById.get(session.lastViewedFileId) ??
                                    getFileById(session.lastViewedFileId) :
                                    undefined;
                            return (
                                <SessionListCard
                                    key={session.id}
                                    name={formatSessionName(session.startedAt)}
                                    lore={formatSessionLore(session)}
                                    viewCount={session.totalViews}
                                    coverFile={cover}
                                    onOpen={() => handleOpenSession(session.id)}
                                />
                            );
                        })}
                    </div>
                )
            ) : activeSession ? (
                <div className="grid grid-cols-3 gap-1.5 px-2 py-3 sm:grid-cols-4">
                    {sessionTiles.map((tile) => (
                        <SessionViewThumb
                            key={tile.key}
                            file={tile.file}
                            index={tile.index}
                            carouselIndex={tile.carouselIndex}
                            onOpen={handleOpenTile}
                        />
                    ))}
                </div>
            ) : null}
            {viewerIndex !== undefined && carouselFiles.length > 0 ? (
                <PhotoViewer
                    files={carouselFiles}
                    initialIndex={viewerIndex}
                    onClose={handleCloseViewer}
                    readOnly
                />
            ) : null}
            <AlertDialog
                open={showDeleteConfirm}
                onOpenChange={(open) => {
                    if (!open) {
                        setShowDeleteConfirm(false);
                    }
                }}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete this session?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This removes the browsing history for this session
                            from Recents. Your photos are not affected.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={handleConfirmDelete}
                        >
                            Delete session
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </AppShell>
    );
}
