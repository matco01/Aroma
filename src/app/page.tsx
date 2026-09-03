import { Board } from "@/components/board";
import { BoardStats } from "@/components/board-stats";
import { LiveTape } from "@/components/live-tape";

export default function BoardPage() {
  return (
    <>
      <LiveTape />

      <div className="mx-auto max-w-[1400px] px-4 py-7">
        {/* No hero. The headline describes what is on the page, the way
            Pons does it — the product is the board underneath. */}
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="max-w-xl">
            <h1 className="text-[19px] font-semibold tracking-[-0.02em] text-ink">
              Board
            </h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">
              Fixed-supply tokens climbing toward graduation on Arc. Gas is
              USDC, so every price you see here is already a dollar — no
              conversion, no second token to hold first.
            </p>
          </div>

          <BoardStats />
        </div>

        <div className="mt-7">
          <Board />
        </div>
      </div>
    </>
  );
}
