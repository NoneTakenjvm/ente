import { useEffect, type JSX } from "react";
import { useRouter } from "next/router";
import { PageLoader } from "@/components/PageLoader";

export default function FavouritesRedirectPage(): JSX.Element {
    const router = useRouter();

    useEffect(() => {
        void router.replace("/gallery");
    }, [router]);

    return <PageLoader message="Opening gallery…" />;
}
