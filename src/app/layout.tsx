import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Box upload test harness",
  description: "Compare Box MCP integration and platform OAuth upload paths.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
