/** A virtualized row is observed only when it intersects the viewport of the
 * focused, visible document. Overscan and selection alone do not count. */
export function observeConversationMessage(element: HTMLElement, observed: () => void): () => void {
  const document = element.ownerDocument;
  const window = document.defaultView;
  if (!window || typeof IntersectionObserver === 'undefined') return () => {};
  let visible = false; let delivered = false;
  const deliver = () => {
    if (delivered || !visible || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    delivered = true; observed();
  };
  const observer = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.target === element && entry.isIntersecting);
    deliver();
  });
  observer.observe(element);
  window.addEventListener('focus', deliver);
  document.addEventListener('visibilitychange', deliver);
  return () => { observer.disconnect(); window.removeEventListener('focus', deliver); document.removeEventListener('visibilitychange', deliver); };
}
