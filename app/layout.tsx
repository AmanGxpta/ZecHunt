import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Fraunces({ variable: "--font-display", subsets: ["latin"], axes: ["opsz"] });
const body = Inter({ variable: "--font-body", subsets: ["latin"] });
const code = JetBrains_Mono({ variable: "--font-code", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "zecHunt — hide a real reward in the real world",
  description:
    "Create a real-world quest, activate it privately with shielded Zcash, and the first person to reach the checkpoint wins a real Bitrefill reward.",
};

export const viewport: Viewport = { themeColor: "#0a0f0d", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${code.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
