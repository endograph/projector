import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Demo - Markov Machines",
  description: "A showcase of markov-machines features with a retro terminal UI",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistMono.variable} antialiased`}>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}
