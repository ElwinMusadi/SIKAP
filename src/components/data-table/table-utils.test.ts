import { describe, expect, it } from 'vitest';
import { pageCountFor, pageNumbers, rangeLabel } from './table-utils';

describe('pageNumbers', () => {
  it('shows every page when there are few', () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it('collapses long ranges around the current page', () => {
    expect(pageNumbers(1, 10)).toEqual([1, 2, 'gap', 10]);
    expect(pageNumbers(5, 10)).toEqual([1, 'gap', 4, 5, 6, 'gap', 10]);
    expect(pageNumbers(10, 10)).toEqual([1, 'gap', 9, 10]);
  });

  it('fills a single-page gap with the page instead of an ellipsis', () => {
    expect(pageNumbers(4, 10)).toEqual([1, 2, 3, 4, 5, 'gap', 10]);
  });

  it('handles empty tables', () => {
    expect(pageNumbers(1, 0)).toEqual([]);
  });
});

describe('rangeLabel and pageCountFor', () => {
  it('describes the visible slice in Indonesian', () => {
    expect(rangeLabel(1, 15, 46)).toBe('Menampilkan 1–15 dari 46');
    expect(rangeLabel(4, 15, 46)).toBe('Menampilkan 46–46 dari 46');
    expect(rangeLabel(1, 15, 0)).toBe('Tidak ada data');
    expect(rangeLabel(1, 50, 1200)).toBe('Menampilkan 1–50 dari 1.200');
  });

  it('never returns zero pages', () => {
    expect(pageCountFor(0, 15)).toBe(1);
    expect(pageCountFor(46, 15)).toBe(4);
  });
});
