import type { Metadata } from "next";
import { AriaApp } from "@/components/AriaApp";
import { brandById } from "@/data/brand";

/** A shared ?brand=veda link shows that brand's name in the tab and in link previews. */
export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const { brand } = await searchParams;
  return { title: `Aria · ${brandById(typeof brand === "string" ? brand : undefined).name} voice care` };
}

export default function Home() {
  return <AriaApp />;
}
