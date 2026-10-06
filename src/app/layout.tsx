import type { Metadata } from "next";
export const metadata: Metadata = { title: "AI SDR Agent v3", description: "Controlled agentic outbound SDR platform" };
const LINKS: Array<[string, string]> = [
  ["/", "Dashboard"],
  ["/campaigns", "Campaigns"],
  ["/approvals", "Approvals"],
  ["/activity", "Agent Activity"],
  ["/onboarding", "Onboarding"],
  ["/settings", "Settings"],
];
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>{`
          :focus-visible { outline: 2px solid #7ea4ff; outline-offset: 2px; }
          .sdr-nav { width: 220px; padding: 20px; border-right: 1px solid #1e2530; background: #0f141c; flex-shrink: 0; }
          .sdr-main { flex: 1; padding: 32px; max-width: 1100px; min-width: 0; }
          @media (max-width: 760px) {
            .sdr-shell { flex-direction: column !important; }
            .sdr-nav { width: auto !important; border-right: 0 !important; border-bottom: 1px solid #1e2530; padding: 12px 16px !important; }
            .sdr-nav-links { display: flex; flex-wrap: wrap; gap: 4px 16px; }
            .sdr-main { padding: 16px !important; }
          }
        `}</style>
      </head>
      <body style={{ fontFamily: "Inter, system-ui, sans-serif", margin: 0, background: "#0b0e14", color: "#e6e9ef" }}>
        <div className="sdr-shell" style={{ display: "flex", minHeight: "100vh" }}>
          <nav className="sdr-nav" aria-label="Primary">
            <div style={{ fontWeight: 800, marginBottom: 16 }}>◈ SDR Agent v3</div>
            <div className="sdr-nav-links">
              {LINKS.map(([h, l]) => (
                <div key={h} style={{ marginBottom: 10 }}><a href={h} style={{ color: "#9fb0c3", textDecoration: "none" }}>{l}</a></div>
              ))}
            </div>
          </nav>
          <main className="sdr-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
