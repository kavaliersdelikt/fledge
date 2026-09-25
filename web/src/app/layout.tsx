import type { Metadata } from "next";
import "./globals.css";
import "./install.css";
export const metadata: Metadata = {
  title: "Fledge · Game server management",
  description: "Control panel for game servers",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}
