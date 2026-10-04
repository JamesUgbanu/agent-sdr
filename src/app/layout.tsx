import type { Metadata } from "next";
export const metadata: Metadata = { title: "AI SDR Agent v3", description: "Controlled agentic outbound SDR platform" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "Inter, system-ui, sans-serif", margin: 0, background: "#0b0e14", color: "#e6e9ef" }}>
        <div style={{ display: "flex", minHeight: "100vh" }}>
          <nav style={{ width: 220, padding: 20, borderRight: "1px solid #1e2530", background: "#0f141c" }}>
            <div style={{ fontWeight: 800, marginBottom: 24 }}>◈ SDR Agent v3</div>
            {[
              ["/", "Dashboard"], ["/campaigns", "Campaigns"], ["/approvals", "Approvals"],
              ["/activity", "Agent Activity"], ["/settings", "Settings"],
            ].map(([h, l]) => (
              <div key={h} style={{ marginBottom: 10 }}><a href={h} style={{ color: "#9fb0c3", textDecoration: "none" }}>{l}</a></div>
            ))}
          </nav>
          <main style={{ flex: 1, padding: 32, maxWidth: 1100 }}>{children}</main>
        </div>
      </body>
    </html>
  );
}
