import Head from "next/head";
import type { AppProps } from "next/app";
import { SessionProvider } from "@/components/SessionProvider";
import { DisablePagePinchZoom } from "@/components/DisablePagePinchZoom";
import { Toaster } from "@/components/ui/sonner";
import "@/styles/inter-subset.css";
import "@/styles/globals.css";

export default function App({ Component, pageProps }: AppProps) {
    return (
        <>
            <Head>
                <title>NTPhotos</title>
                <meta
                    key="viewport"
                    name="viewport"
                    content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, viewport-fit=cover, interactive-widget=resizes-content"
                />
                <meta name="theme-color" content="#0f0f0f" />
                <meta name="apple-mobile-web-app-capable" content="yes" />
                <meta name="apple-mobile-web-app-title" content="NTPhotos" />
                <meta
                    name="apple-mobile-web-app-status-bar-style"
                    content="black-translucent"
                />
                <link rel="manifest" href="/manifest.webmanifest" />
                <link rel="apple-touch-icon" href="/icons/icon-192.png" />
            </Head>
            <div className="dark min-h-dvh">
                <DisablePagePinchZoom />
                <SessionProvider>
                    <Component {...pageProps} />
                </SessionProvider>
                <Toaster position="top-center" richColors closeButton />
            </div>
        </>
    );
}
