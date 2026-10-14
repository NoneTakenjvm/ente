import { useEffect, type JSX } from "react";
import { useRouter } from "next/router";
import { AppShell } from "@/components/AppShell";
import { ManageCompressPanel } from "@/components/manage/ManageCompressPanel";
import {
    ManageHub,
    ManageToolsHub,
    isManageSection,
    isManageToolSection,
    manageSectionTitle,
    type ManageSection,
} from "@/components/manage/ManageHub";
import { ManageArchivedPanel } from "@/components/manage/ManageArchivedPanel";
import { ManageDuplicatesPanel } from "@/components/manage/ManageDuplicatesPanel";
import { ManageSimilarPanel } from "@/components/manage/ManageSimilarPanel";
import { ManageTrashPanel } from "@/components/manage/ManageTrashPanel";
import { ManageUsagePanel } from "@/components/manage/ManageUsagePanel";
import { ManageAutoCropPanel } from "@/components/manage/ManageAutoCropPanel";
import { ManageSettingsPanel } from "@/components/manage/ManageSettingsPanel";
import { ManageTagsPanel } from "@/components/manage/ManageTagsPanel";
import { PageLoader } from "@/components/PageLoader";
import { useLibraryBootstrap } from "@/hooks/use-library-bootstrap";
import { useLibraryLoading } from "@/hooks/use-library-loading";
import { APP_VERSION } from "@/lib/app-version";
import { useSessionStore } from "@/stores/session-store";
import { useLibraryStore } from "@/stores/library-store";
import { usePhashIndexStore } from "@/stores/phash-index-store";
import { useEmbeddingIndexStore } from "@/stores/embedding-index-store";
import { useQualityIndexStore } from "@/stores/quality-index-store";

export default function ManagePage(): JSX.Element {
    const router = useRouter();
    const email = useSessionStore((s) => s.email);

    const allFiles = useLibraryStore((s) => s.allFiles);

    const hydratePhash = usePhashIndexStore((s) => s.ensureHydrated);
    const embeddingHydrated = useEmbeddingIndexStore((s) => s.isHydrated);
    const hydrateEmbeddings = useEmbeddingIndexStore((s) => s.ensureHydrated);
    const hydrateQuality = useQualityIndexStore((s) => s.ensureHydrated);

    const querySection = router.query.section;
    const section: ManageSection = isManageSection(querySection) ?
        querySection :
        "hub";
    const initialLoadDone = useLibraryBootstrap({
        afterSync: async (): Promise<void> => {
            await Promise.all([
                hydratePhash(),
                hydrateEmbeddings(),
                hydrateQuality(),
            ]);
        },
    });

    useEffect(() => {
        if (embeddingHydrated) {
            return;
        }
        void hydrateEmbeddings();
    }, [embeddingHydrated, hydrateEmbeddings]);

    const handleSelectSection = (next: Exclude<ManageSection, "hub">): void => {
        void router.replace(
            { pathname: "/manage", query: { section: next } },
            undefined,
            { shallow: true },
        );
    };

    const handleBack = (): void => {
        if (isManageToolSection(section)) {
            handleSelectSection("tools");
            return;
        }
        void router.replace("/manage", undefined, { shallow: true });
    };

    const showFullPageLoader = useLibraryLoading(initialLoadDone);

    return (
        <AppShell
            title={section === "hub" ? "Manage" : manageSectionTitle(section)}
            email={email}
            onBack={section === "hub" ? undefined : handleBack}
        >
            {section === "hub" ? (
                <ManageHub onSelect={handleSelectSection} />
            ) : null}

            {section === "tools" ? (
                <ManageToolsHub onSelect={handleSelectSection} />
            ) : null}

            {section === "tags" ? <ManageTagsPanel /> : null}

            {section === "settings" ? <ManageSettingsPanel /> : null}

            {section === "usage" ? <ManageUsagePanel /> : null}

            {section === "archived" ? (
                <ManageArchivedPanel files={allFiles} />
            ) : null}

            {section === "trash" ? <ManageTrashPanel /> : null}

            {section === "auto-crop" ? (
                <ManageAutoCropPanel files={allFiles} />
            ) : null}

            {section === "compress" ? (
                showFullPageLoader ? (
                    <PageLoader message="Loading your library…" />
                ) : (
                    <ManageCompressPanel
                        files={allFiles}
                        libraryLoaded={initialLoadDone}
                    />
                )
            ) : null}

            {section === "exact" ? (
                <ManageDuplicatesPanel showLoader={showFullPageLoader} />
            ) : null}

            {section === "similar" ? (
                <ManageSimilarPanel showLoader={showFullPageLoader} />
            ) : null}

            <p className="px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] text-center text-[11px] text-muted-foreground/70">
                NTPhotos {APP_VERSION}
            </p>
        </AppShell>
    );
}
