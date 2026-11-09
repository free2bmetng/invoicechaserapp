import Link from "next/link";

// Shown when a sequence id does not exist or belongs to another account.
export default function SequenceNotFound() {
  return (
    <div className="mx-auto grid max-w-md gap-4 py-16 text-center">
      <h1 className="text-[24px] font-semibold tracking-[-0.02em] text-ink">We could not find that sequence</h1>
      <p className="text-[15px] leading-6 text-ink-2">It may have been deleted, or the link is out of date.</p>
      <div>
        <Link href="/sequences" className="inline-flex h-11 items-center rounded-[10px] bg-accent px-4 text-sm font-medium text-accent-ink hover:bg-accent-hover">
          Back to sequences
        </Link>
      </div>
    </div>
  );
}
