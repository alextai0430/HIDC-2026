import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
export const metadata: Metadata = {
  title: "HIDC 2026 · Judge Console",
  description: "Houston International Diabolo Competition scoring workspace",
  icons: { icon: "/ndl-emblem.png" },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {process.env.NODE_ENV !== "production" ? (
          <Script id="clear-stale-local-service-worker" strategy="beforeInteractive">
            {`(() => {
              if (!["localhost", "127.0.0.1"].includes(location.hostname) || !("serviceWorker" in navigator) || !("caches" in window)) return;
              const resetKey = "hidc-dev-service-worker-reset-v2";
              try {
                if (sessionStorage.getItem(resetKey)) return;
                Promise.all([navigator.serviceWorker.getRegistrations(), caches.keys()]).then(async ([registrations, cacheNames]) => {
                  const workerUrl = new URL("/sw.js", location.origin).href;
                  const appRegistrations = registrations.filter((registration) =>
                    [registration.active, registration.waiting, registration.installing]
                      .some((worker) => worker?.scriptURL === workerUrl),
                  );
                  const hasAppCache = cacheNames.includes("hidc-shell-v1");
                  if (!appRegistrations.length && !hasAppCache) return;
                  sessionStorage.setItem(resetKey, "1");
                  const [removed, cacheRemoved] = await Promise.all([
                    Promise.all(appRegistrations.map((registration) => registration.unregister())),
                    hasAppCache ? caches.delete("hidc-shell-v1") : Promise.resolve(false),
                  ]);
                  if (removed.some(Boolean) || cacheRemoved) location.reload();
                  else sessionStorage.removeItem(resetKey);
                }).catch(() => {});
              } catch {}
            })();`}
          </Script>
        ) : null}
        {children}
      </body>
    </html>
  );
}
