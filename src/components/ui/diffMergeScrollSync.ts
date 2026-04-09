interface MapScrollOffsetByRatioParams {
  sourceOffset: number;
  sourceScrollSize: number;
  sourceClientSize: number;
  targetScrollSize: number;
  targetClientSize: number;
}

const getScrollableDistance = (scrollSize: number, clientSize: number): number =>
  Math.max(0, scrollSize - clientSize);

export const mapScrollOffsetByRatio = ({
  sourceOffset,
  sourceScrollSize,
  sourceClientSize,
  targetScrollSize,
  targetClientSize,
}: MapScrollOffsetByRatioParams): number => {
  const sourceScrollableDistance = getScrollableDistance(sourceScrollSize, sourceClientSize);
  const targetScrollableDistance = getScrollableDistance(targetScrollSize, targetClientSize);

  if (sourceScrollableDistance <= 0 || targetScrollableDistance <= 0) {
    return 0;
  }

  const ratio = Math.max(0, Math.min(1, sourceOffset / sourceScrollableDistance));
  return ratio * targetScrollableDistance;
};
