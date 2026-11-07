import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { isLocalImagePath, ProductImage } from '../ProductImage';

describe('isLocalImagePath', () => {
  it('accepts a path of the site', () => {
    for (const ok of [
      '/images/stars.png',
      '/assets/products/telegram-stars.svg',
      '/a/b.webp?v=2',
    ]) {
      expect(isLocalImagePath(ok), ok).toBe(true);
    }
  });

  it('refuses everything that could load from another host', () => {
    for (const bad of [
      '',
      'images/stars.png',
      'https://evil.example/x.png',
      '//evil.example/x.png',
      '/\\evil.example/x.png',
      'javascript:alert(1)',
      'data:image/svg+xml,<svg/>',
      'blob:https://site.example/1',
      '/a\u0000b.png',
      '/a\nb.png',
    ]) {
      expect(isLocalImagePath(bad), bad).toBe(false);
    }
  });
});

describe('ProductImage', () => {
  const view = (src: string) =>
    render(
      <span style={{ position: 'relative' }}>
        <ProductImage src={src} alt="Steam" sizes="50vw" />
      </span>,
    );

  it('draws the picture with the product name as its text', () => {
    view('/assets/products/steam.svg');
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('Steam');
  });

  it('shows the empty slot, named after the product, for an unusable source', () => {
    const { getByRole } = view('https://evil.example/x.png');
    expect(document.querySelector('img')).toBeNull();
    expect(getByRole('img', { name: 'Steam' })).toBeInTheDocument();
  });

  it('falls back to the empty slot when the picture fails to load', () => {
    const { getByRole } = view('/assets/products/missing.png');
    const image = document.querySelector('img');
    expect(image).not.toBeNull();
    if (image) fireEvent.error(image);
    expect(document.querySelector('img')).toBeNull();
    expect(getByRole('img', { name: 'Steam' })).toBeInTheDocument();
  });

  it('decorative: an empty alt with a picture, nothing at all without one', () => {
    const withPicture = render(
      <ProductImage src="/assets/a.svg" alt="Steam" sizes="64px" decorative />,
    );
    expect(document.querySelector('img')?.getAttribute('alt')).toBe('');
    withPicture.unmount();
    const without = render(
      <ProductImage src="https://evil.example/x.png" alt="Steam" sizes="64px" decorative />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(without.container).toBeEmptyDOMElement();
  });
});
