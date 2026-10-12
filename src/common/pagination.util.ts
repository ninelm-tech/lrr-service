export interface PageParams {
  page: number;
  limit: number;
}

const MAX_PAGE = 1_000_000;

/**
 * Query-string paging → safe integers. Fractional, negative, NaN and huge
 * values never reach Prisma's skip/take (which would 500 on them).
 */
export function parsePagination(
  page?: string,
  limit?: string,
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): PageParams {
  const defaultLimit = opts.defaultLimit ?? 25;
  const maxLimit = opts.maxLimit ?? 100;

  const p = Math.floor(Number(page));
  const l = Math.floor(Number(limit));

  return {
    page: Number.isFinite(p) && p >= 1 ? Math.min(p, MAX_PAGE) : 1,
    limit: Number.isFinite(l) && l >= 1 ? Math.min(l, maxLimit) : defaultLimit,
  };
}
