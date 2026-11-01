"use client";

import { useId, type ReactNode } from "react";

export type Segment<T extends string> = { value: T; label: ReactNode; disabled?: boolean; title?: string };

/** One choice from a few, always visible. Real radio buttons, so arrow keys, forms and screen readers work without help. */
export function Segmented<T extends string>({ label, value, options, onChange, className = "" }: { label: string; value: T; options: Segment<T>[]; onChange: (value: T) => void; className?: string }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={`grid auto-cols-fr grid-flow-col gap-0.5 rounded-[11px] bg-field p-0.5 ${className}`}>
      {options.map((o) => (
        <label key={o.value} title={o.title} className={`relative min-w-0 ${o.disabled ? "cursor-not-allowed" : "cursor-pointer"}`}>
          <input type="radio" name={name} className="peer absolute inset-0 m-0 opacity-0" value={o.value} checked={value === o.value} disabled={o.disabled} onChange={() => onChange(o.value)} />
          <span className="flex min-h-11 items-center justify-center gap-1.5 truncate rounded-[9px] px-2.5 text-sm font-medium text-ink-2 transition-colors duration-150 peer-checked:bg-surface peer-checked:text-ink peer-checked:shadow-btn peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-accent peer-disabled:text-ink-3 peer-disabled:opacity-70 sm:min-h-9">
            {o.label}
          </span>
        </label>
      ))}
    </div>
  );
}
