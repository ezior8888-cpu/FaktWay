'use client';

import { SegmentErrorCard } from '@/components/segment-error-card';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <SegmentErrorCard error={error} reset={reset} />;
}
