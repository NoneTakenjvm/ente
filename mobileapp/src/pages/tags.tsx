import { useEffect, type JSX } from "react";
import { useRouter } from "next/router";
import { PageLoader } from "@/components/PageLoader";
import {
    isSessionAuthenticated,
    reconcileSessionWithCore,
} from "@/stores/session-store";

export default function TagsPage(): JSX.Element {
    const router = useRouter();

    useEffect(() => {
        reconcileSessionWithCore();
        if (!isSessionAuthenticated()) {
            void router.replace("/login");
            return;
        }
        void router.replace("/manage?section=tags");
    }, [router]);

    return <PageLoader message="Opening tag management…" />;
}
