import { imageContentToSrc } from './image-src';
import { describe, expect, it } from 'vitest';

describe('imageContentToSrc', () => {
  describe('already-usable sources (passthrough)', () => {
    it('returns a base64 PNG data URL unchanged', () => {
      const src = 'data:image/png;base64,iVBORw0KGgo=';
      expect(imageContentToSrc(src)).toBe(src);
    });

    it('returns an svg+xml data URL unchanged (no double-wrapping)', () => {
      const src = 'data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E';
      expect(imageContentToSrc(src)).toBe(src);
    });

    it('returns an https URL unchanged', () => {
      const src = 'https://lh3.googleusercontent.com/abc.png';
      expect(imageContentToSrc(src)).toBe(src);
    });

    it('returns an http URL unchanged', () => {
      const src = 'http://example.com/img.jpg';
      expect(imageContentToSrc(src)).toBe(src);
    });
  });

  describe('bare base64 fallback', () => {
    it('wraps bare base64 as a PNG data URL', () => {
      expect(imageContentToSrc('iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
    });

    it('preserves base64 special characters (+ / =)', () => {
      const b64 = 'AB+/cd==';
      expect(imageContentToSrc(b64)).toBe(`data:image/png;base64,${b64}`);
    });

    it('preserves prior behavior for empty content', () => {
      expect(imageContentToSrc('')).toBe('data:image/png;base64,');
    });
  });

  describe('raw SVG markup (the Gemini-web regression)', () => {
    // Gemini "draws" by emitting raw SVG as create_document content. It must render
    // as an svg+xml data URL, not be mis-tagged as base64 PNG (broken/empty image).
    it('encodes a bare <svg> root as an svg+xml data URL', () => {
      const svg = '<svg viewBox="0 0 10 10"><rect/></svg>';
      const src = imageContentToSrc(svg);
      expect(src).toBe(`data:image/svg+xml,${encodeURIComponent(svg)}`);
      expect(src.includes('base64')).toBe(false);
    });

    it('matches <svg> with no attributes', () => {
      expect(imageContentToSrc('<svg></svg>').startsWith('data:image/svg+xml,')).toBe(true);
    });

    it('is case-insensitive on the tag name', () => {
      expect(
        imageContentToSrc('<SVG viewBox="0 0 1 1"></SVG>').startsWith('data:image/svg+xml,'),
      ).toBe(true);
    });

    it('handles leading whitespace before the SVG root', () => {
      expect(
        imageContentToSrc('\n  <svg viewBox="0 0 10 10"></svg>').startsWith('data:image/svg+xml,'),
      ).toBe(true);
    });

    it('handles an XML prolog wrapping an SVG', () => {
      const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<svg viewBox="0 0 10 10"></svg>';
      expect(imageContentToSrc(svg).startsWith('data:image/svg+xml,')).toBe(true);
    });

    it('roundtrips: the data URL decodes back to the original SVG', () => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><circle cx="100" cy="100" r="40"/></svg>';
      const src = imageContentToSrc(svg);
      const decoded = decodeURIComponent(src.slice('data:image/svg+xml,'.length));
      expect(decoded).toBe(svg);
    });

    it('renders the real-world panda SVG reported in the bug', () => {
      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" width="100%" height="100%">',
        '  <rect width="200" height="200" fill="#f0fdf4" rx="20"/>',
        '  <circle cx="50" cy="50" r="25" fill="#2d3748"/>',
        '  <circle cx="100" cy="100" r="65" fill="#ffffff" stroke="#2d3748" stroke-width="4"/>',
        '</svg>',
      ].join('\n');
      const src = imageContentToSrc(svg);
      expect(src.startsWith('data:image/svg+xml,')).toBe(true);
      expect(decodeURIComponent(src.slice('data:image/svg+xml,'.length))).toBe(svg);
    });
  });

  describe('negative cases (not treated as SVG)', () => {
    it('treats non-SVG HTML as base64', () => {
      const html = '<div>not an image</div>';
      expect(imageContentToSrc(html)).toBe(`data:image/png;base64,${html}`);
    });

    it('does not match <svg> appearing mid-string', () => {
      const text = 'prefix <svg></svg>';
      expect(imageContentToSrc(text)).toBe(`data:image/png;base64,${text}`);
    });

    it('does not treat the word "svgfoo" as an svg tag', () => {
      const text = '<svgfoo>bar</svgfoo>';
      expect(imageContentToSrc(text)).toBe(`data:image/png;base64,${text}`);
    });

    it('does not treat an XML prolog without an SVG as SVG', () => {
      const xml = '<?xml version="1.0"?><root><child/></root>';
      expect(imageContentToSrc(xml)).toBe(`data:image/png;base64,${xml}`);
    });
  });
});
