import { useEffect, useRef, useState } from 'react';

/** Pixel threshold: how close to the bottom counts as 'near bottom'. */
const SCROLL_NEAR_BOTTOM_THRESHOLD = 30;

/**
 * Auto-scroll-to-bottom hook for log-style scroll containers.
 * Scrolls to the bottom when `dep` changes IF the user is already at/near
 * the bottom. Scrolling up pauses auto-scroll; scrolling back resumes it.
 */
export function useAutoScroll<T>(dep: T) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = () => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isNearBottom = scrollHeight - scrollTop - clientHeight < SCROLL_NEAR_BOTTOM_THRESHOLD;
      setAutoScroll(isNearBottom);
    }
  };

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [autoScroll, dep]);

  return { scrollRef, autoScroll, handleScroll };
}
