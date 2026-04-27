import { useCallback, useEffect, useState } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

export const useElementSize = <T extends HTMLElement>() => {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });
  const [node, setNode] = useState<T | null>(null);

  const ref = useCallback((element: T | null) => {
    setNode(element);
  }, []);

  useEffect(() => {
    if (!node) {
      setSize({ width: 0, height: 0 });
      return;
    }

    const updateSize = () => {
      setSize({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  return { ref, width: size.width, height: size.height };
};
