import { useEffect, type JSX } from "react";
import { useRouter } from "next/router";

export default function DedupRedirectPage(): JSX.Element | null {
    const router = useRouter();

    useEffect(() => {
        void router.replace("/manage");
    }, [router]);

    return null;
}
