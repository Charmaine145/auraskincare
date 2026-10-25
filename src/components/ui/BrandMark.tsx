import type { BrandId } from "@/data/brand";

/**
 * The brand mark: one rounded badge, two symbols.
 * Aura Skincare uses a four-point sparkle; Aura Haircare uses flowing strands.
 */
export function BrandMark({ brand }: { brand: BrandId }) {
  return (
    <span className="brand-mark" data-brand={brand} aria-hidden>
      {brand === "veda" ? (
        <svg className="mark-glyph" viewBox="0 0 36 36" focusable="false">
          <path className="mark-strand" d="M9 29C14.8 22.6 10.4 15.1 16.6 7" />
          <path className="mark-strand" d="M15.1 30C21.8 22.8 16 14.8 23.3 6" />
          <path className="mark-strand" d="M21.4 29C27.5 22.7 22 16.5 28 10" />
        </svg>
      ) : (
        <svg className="mark-glyph" viewBox="0 0 36 36" focusable="false">
          <path
            className="mark-sparkle"
            d="M18 3.2C19.4 11.1 24.9 16.6 32.8 18 24.9 19.4 19.4 24.9 18 32.8 16.6 24.9 11.1 19.4 3.2 18 11.1 16.6 16.6 11.1 18 3.2Z"
          />
        </svg>
      )}
    </span>
  );
}
