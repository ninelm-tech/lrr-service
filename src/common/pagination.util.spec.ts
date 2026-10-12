import { parsePagination } from './pagination.util';

describe('parsePagination', () => {
  it('uses defaults when absent', () => {
    expect(parsePagination()).toEqual({ page: 1, limit: 25 });
  });

  it.each([
    ['2', '10', { page: 2, limit: 10 }],
    ['1.5', '2.5', { page: 1, limit: 2 }],
    ['-3', '0', { page: 1, limit: 25 }],
    ['abc', 'xyz', { page: 1, limit: 25 }],
    ['1e21', '9999', { page: 1_000_000, limit: 100 }],
    ['Infinity', 'Infinity', { page: 1, limit: 25 }],
  ])('page=%s limit=%s -> %p', (page, limit, expected) => {
    expect(parsePagination(page, limit)).toEqual(expected);
  });
});
