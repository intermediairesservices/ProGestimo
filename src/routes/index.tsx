import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Progestimo — Gestion d'argent multidevise" },
      { name: "description", content: "PWA hors ligne pour suivre vos entrées, dépenses et prêts en plusieurs devises." },
      { property: "og:title", content: "Progestimo — Gestion d'argent multidevise" },
      { property: "og:description", content: "Suivez entrées, dépenses et prêts en plusieurs devises, 100% hors ligne." },
    ],
  }),
  component: Index,
});

function Index() {
  if (typeof window !== "undefined" && window.location.pathname === "/") {
    window.location.replace("/pwa.html");
  }
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0f172a", color: "#f1f5f9", fontFamily: "system-ui, sans-serif" }}>
      <a href="/pwa.html" style={{ color: "#f1f5f9" }}>Ouvrir Progestimo</a>
    </div>
  );
}
