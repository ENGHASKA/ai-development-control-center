"use client";

import { Menu } from "iconoir-react";
import type { ReactNode } from "react";
import { PlanBody } from "./PlanDetail";

/** An Auto plan as a conversation: the request, then its plan, agents, reviews and result, all from the server's record. */
export function PlanConversation({ id, onMenu, extra }: { id: string; onMenu: () => void; extra?: ReactNode }) {
  return (
    <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="safe-top flex shrink-0 items-center px-[max(0.375rem,env(safe-area-inset-left))]">
        <div className="flex h-14 w-full items-center gap-1 pr-[max(0.375rem,env(safe-area-inset-right))]">
          <button type="button" onClick={onMenu} aria-label="Open sessions" aria-haspopup="dialog" data-drawer-opener className="flex size-10 items-center justify-center rounded-[10px] text-ink-2 hover:bg-hover hover:text-ink lg:hidden">
            <Menu width={19} height={19} strokeWidth={1.8} />
          </button>
          <span className="min-w-0 flex-1 truncate px-1 text-base font-semibold tracking-[-0.01em] text-ink">Auto plan</span>
          <a href={`/tasks?plan=${id}`} className="inline-flex min-h-11 shrink-0 items-center px-2 text-sm text-ink-2 underline underline-offset-2 hover:text-ink">Details</a>
          {extra}
        </div>
      </header>
      <div className="safe-x safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-(--thread-w) px-4 pt-2 pb-10">
          <PlanBody id={id} inline />
        </div>
      </div>
    </section>
  );
}
