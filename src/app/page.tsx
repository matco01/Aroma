import { Board } from "@/components/board";

/**
 * Straight into the board. No hero, no heading, no explainer.
 *
 * The argument against a landing page rules out the copy above the grid
 * too: the people arriving here are traders who already know what a
 * launchpad is, and every line spent telling them sits between them and
 * the coins. There used to be 188px of title, paragraph and stat row
 * before the first token — a fifth of the viewport explaining the page
 * instead of being it.
 *
 * The nav already says which page this is.
 */
export default function BoardPage() {
  return (
    <div className="mx-auto max-w-[1400px] px-4 py-4">
      <Board />
    </div>
  );
}
