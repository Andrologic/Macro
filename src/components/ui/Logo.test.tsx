import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Logo } from './Logo';

describe('Logo', () => {
  it('uses the public logo asset as a mask instead of inlining the shape', () => {
    const markup = renderToStaticMarkup(<Logo size={32} className="brand-logo" />);

    expect(markup).toContain('mask-image:url(&#x27;/logo.svg&#x27;)');
    expect(markup).toContain('-webkit-mask-image:url(&#x27;/logo.svg&#x27;)');
    expect(markup).toContain('width:32px');
    expect(markup).toContain('height:32px');
    expect(markup).toContain('brand-logo');
    expect(markup).not.toContain('<path');
    expect(markup).not.toContain('<svg');
  });
});
